using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>
/// Validates against the JSON schemas in Yomitan's ext/data/schemas, embedded at build time, so what this
/// importer accepts follows the pinned Yomitan rather than a hand-written copy of its rules. It implements the
/// draft-07 keywords those schemas use, with ajv's semantics, and refuses to load a schema using any other.
/// </summary>
internal sealed class JsonSchema
{
    private static readonly Dictionary<string, JsonSchema> Loaded = new(StringComparer.Ordinal);

    private readonly string _name;
    private readonly JsonElement _root;
    private readonly Dictionary<string, Reference> _references = new(StringComparer.Ordinal);
    private readonly Check _check;
    private readonly Check? _item;

    private JsonSchema(string name, JsonElement root)
    {
        _name = name;
        _root = root;
        _check = Compile(root);
        if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Object)
        {
            _item = Compile(items);
        }
    }

    private delegate bool Check(JsonElement value);

    /// <summary>Loads a schema by its file name without the "-schema.json" suffix.</summary>
    public static JsonSchema Load(string name)
    {
        lock (Loaded)
        {
            if (!Loaded.TryGetValue(name, out var schema))
            {
                var resource = $"Jellyfin.Plugin.Yomitan.schemas.{name}-schema.json";
                using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)
                    ?? throw new InvalidOperationException($"Missing embedded schema {resource}");
                schema = new JsonSchema(name, JsonDocument.Parse(stream).RootElement);
                Loaded.Add(name, schema);
            }

            return schema;
        }
    }

    public bool IsValid(JsonElement value) => _check(value);

    /// <summary>Validates a bank, naming the first bad row. The file is one array of rows, as all banks are.</summary>
    public void ValidateBank(JsonElement bank, string fileName)
    {
        if (bank.ValueKind != JsonValueKind.Array || _item is null)
        {
            throw new ImportException("invalid_bank", $"{fileName} does not match {_name}: the root must be an array");
        }

        var index = 0;
        foreach (var row in bank.EnumerateArray())
        {
            if (!_item(row))
            {
                var text = row.GetRawText();
                throw new ImportException(
                    "invalid_bank",
                    $"{fileName} row {index} does not match {_name}: {text[..Math.Min(text.Length, 200)]}");
            }

            index++;
        }
    }

    private static bool IsFiniteNumber(JsonElement value)
        => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number);

    private static bool IsInteger(JsonElement value)
        => IsFiniteNumber(value) && Math.Floor(value.GetDouble()) == value.GetDouble();

    private static Check TypeCheck(JsonElement type)
    {
        Check One(string name) => name switch
        {
            "string" => v => v.ValueKind == JsonValueKind.String,
            "number" => IsFiniteNumber,
            "integer" => IsInteger,
            "boolean" => v => v.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "object" => v => v.ValueKind == JsonValueKind.Object,
            "array" => v => v.ValueKind == JsonValueKind.Array,
            "null" => v => v.ValueKind == JsonValueKind.Null,
            _ => throw new NotSupportedException($"Unknown schema type {name}"),
        };

        if (type.ValueKind == JsonValueKind.String)
        {
            return One(type.GetString()!);
        }

        var any = type.EnumerateArray().Select(t => One(t.GetString()!)).ToArray();
        return v => Array.Exists(any, check => check(v));
    }

    private static bool JsonEquals(JsonElement a, JsonElement b)
    {
        if (a.ValueKind == JsonValueKind.Number && b.ValueKind == JsonValueKind.Number)
        {
            return a.GetDouble() == b.GetDouble();
        }

        return JsonElement.DeepEquals(a, b);
    }

    private static int CodePointLength(string text)
    {
        var length = text.Length;
        for (var i = 1; i < text.Length; i++)
        {
            if (char.IsSurrogatePair(text[i - 1], text[i]))
            {
                length--;
                i++;
            }
        }

        return length;
    }

    private static bool All(Check[] checks, JsonElement value)
    {
        foreach (var check in checks)
        {
            if (!check(value))
            {
                return false;
            }
        }

        return true;
    }

    private Check Compile(JsonElement schema)
    {
        if (schema.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            var result = schema.ValueKind == JsonValueKind.True;
            return _ => result;
        }

        // The cheap, discriminating checks run first: most oneOf branches fail on a const.
        var early = new List<Check>();
        var late = new List<Check>();
        foreach (var keyword in schema.EnumerateObject())
        {
            var value = keyword.Value;
            switch (keyword.Name)
            {
                case "$id" or "$schema" or "definitions" or "description" or "default":
                    break;
                case "properties" or "additionalProperties" or "required":
                    // Handled together, below.
                    break;
                case "items" or "additionalItems" or "minItems" or "maxItems":
                    break;
                case "$ref":
                    late.Add(Resolve(value.GetString()!));
                    break;
                case "type":
                    early.Add(TypeCheck(value));
                    break;
                case "const":
                    early.Add(v => JsonEquals(v, value));
                    break;
                case "enum":
                    var options = value.EnumerateArray().ToArray();
                    early.Add(v => Array.Exists(options, option => JsonEquals(v, option)));
                    break;
                case "minLength":
                    var minLength = value.GetInt32();
                    early.Add(v => v.ValueKind != JsonValueKind.String || CodePointLength(v.GetString()!) >= minLength);
                    break;
                case "minimum":
                    var minimum = value.GetDouble();
                    early.Add(v => v.ValueKind != JsonValueKind.Number || v.GetDouble() >= minimum);
                    break;
                case "pattern":
                    // ECMAScript mode gives JavaScript's meaning of \w and friends. $ would also match before a
                    // final newline here, which JavaScript's does not.
                    var regex = new Regex(value.GetString()!.Replace("$", "(?!\\n)$", StringComparison.Ordinal), RegexOptions.ECMAScript);
                    early.Add(v => v.ValueKind != JsonValueKind.String || regex.IsMatch(v.GetString()!));
                    break;
                case "oneOf":
                    var oneOf = value.EnumerateArray().Select(Compile).ToArray();
                    late.Add(v =>
                    {
                        var matches = 0;
                        foreach (var check in oneOf)
                        {
                            if (check(v) && ++matches > 1)
                            {
                                return false;
                            }
                        }

                        return matches == 1;
                    });
                    break;
                case "anyOf":
                    var anyOf = value.EnumerateArray().Select(Compile).ToArray();
                    late.Add(v => Array.Exists(anyOf, check => check(v)));
                    break;
                case "dependencies":
                    var dependencies = value.EnumerateObject()
                        .Select(d => (d.Name, Required: d.Value.EnumerateArray().Select(r => r.GetString()!).ToArray()))
                        .ToArray();
                    early.Add(v => v.ValueKind != JsonValueKind.Object || Array.TrueForAll(
                        dependencies,
                        d => !v.TryGetProperty(d.Name, out _) || Array.TrueForAll(d.Required, r => v.TryGetProperty(r, out _))));
                    break;
                default:
                    throw new NotSupportedException($"Schema {_name} uses unsupported keyword {keyword.Name}");
            }
        }

        var objectCheck = CompileObject(schema);
        if (objectCheck is not null)
        {
            early.Add(objectCheck);
        }

        var arrayCheck = CompileArray(schema);
        if (arrayCheck is not null)
        {
            early.Add(arrayCheck);
        }

        var checks = early.Concat(late).ToArray();
        return checks.Length == 1 ? checks[0] : v => All(checks, v);
    }

    private Check? CompileObject(JsonElement schema)
    {
        var hasProperties = schema.TryGetProperty("properties", out var properties);
        var hasAdditional = schema.TryGetProperty("additionalProperties", out var additional);
        var hasRequired = schema.TryGetProperty("required", out var requiredList);
        if (!hasProperties && !hasAdditional && !hasRequired)
        {
            return null;
        }

        var known = new Dictionary<string, Check>(StringComparer.Ordinal);
        var discriminators = new List<(string Name, Check Check)>();
        if (hasProperties)
        {
            foreach (var property in properties.EnumerateObject())
            {
                var check = Compile(property.Value);
                known.Add(property.Name, check);

                // Without this a wrong oneOf branch can recurse into "content" before reaching "tag", which
                // costs branches^depth on structured content.
                if (property.Value.TryGetProperty("const", out _) || property.Value.TryGetProperty("enum", out _))
                {
                    discriminators.Add((property.Name, check));
                }
            }
        }

        var required = hasRequired ? requiredList.EnumerateArray().Select(r => r.GetString()!).ToArray() : [];
        Check? other = hasAdditional ? Compile(additional) : null;
        var firstChecks = discriminators.ToArray();

        return value =>
        {
            if (value.ValueKind != JsonValueKind.Object)
            {
                return true;
            }

            foreach (var (name, check) in firstChecks)
            {
                if (value.TryGetProperty(name, out var property) && !check(property))
                {
                    return false;
                }
            }

            foreach (var name in required)
            {
                if (!value.TryGetProperty(name, out _))
                {
                    return false;
                }
            }

            foreach (var property in value.EnumerateObject())
            {
                if (known.TryGetValue(property.Name, out var check))
                {
                    if (!check(property.Value))
                    {
                        return false;
                    }
                }
                else if (other is not null && !other(property.Value))
                {
                    return false;
                }
            }

            return true;
        };
    }

    private Check? CompileArray(JsonElement schema)
    {
        var hasItems = schema.TryGetProperty("items", out var items);
        var hasMin = schema.TryGetProperty("minItems", out var minElement);
        var hasMax = schema.TryGetProperty("maxItems", out var maxElement);
        var hasAdditional = schema.TryGetProperty("additionalItems", out var additional);
        if (!hasItems && !hasMin && !hasMax)
        {
            return null;
        }

        var min = hasMin ? minElement.GetInt32() : 0;
        var max = hasMax ? maxElement.GetInt32() : int.MaxValue;
        var tuple = hasItems && items.ValueKind == JsonValueKind.Array
            ? items.EnumerateArray().Select(Compile).ToArray()
            : [];
        Check? rest = null;
        if (hasItems)
        {
            if (items.ValueKind != JsonValueKind.Array)
            {
                rest = Compile(items);
            }
            else if (hasAdditional)
            {
                rest = Compile(additional);
            }
        }

        return value =>
        {
            if (value.ValueKind != JsonValueKind.Array)
            {
                return true;
            }

            var length = value.GetArrayLength();
            if (length < min || length > max)
            {
                return false;
            }

            var index = 0;
            foreach (var item in value.EnumerateArray())
            {
                var check = index < tuple.Length ? tuple[index] : rest;
                if (check is not null && !check(item))
                {
                    return false;
                }

                index++;
            }

            return true;
        };
    }

    /// <summary>Resolves a "#/definitions/x" reference. The target is compiled once, so recursion terminates.</summary>
    private Check Resolve(string reference)
    {
        const string Prefix = "#/definitions/";
        if (!reference.StartsWith(Prefix, StringComparison.Ordinal))
        {
            throw new NotSupportedException($"Unsupported $ref {reference}");
        }

        if (!_references.TryGetValue(reference, out var target))
        {
            target = new Reference();
            _references.Add(reference, target);
            target.Check = Compile(_root.GetProperty("definitions").GetProperty(reference[Prefix.Length..]));
        }

        return v => target.Check!(v);
    }

    private sealed class Reference
    {
        public Check? Check { get; set; }
    }
}

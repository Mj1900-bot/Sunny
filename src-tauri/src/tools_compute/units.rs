use super::calc::{format_number_f64};

// convert_units — unit conversion for common classes.
// ---------------------------------------------------------------------------

/// Convert a value between two units of the same physical class.
/// Temperature is handled as a special affine case; every other class is
/// normalized to a base unit and then multiplied out.
#[tauri::command]
pub async fn convert_units(value: f64, from: String, to: String) -> Result<String, String> {
    if !value.is_finite() {
        return Err("convert_units: value must be finite".into());
    }
    let from_k = canonical_unit(&from)
        .ok_or_else(|| format!("convert_units: unknown unit \"{from}\""))?;
    let to_k = canonical_unit(&to)
        .ok_or_else(|| format!("convert_units: unknown unit \"{to}\""))?;
    if from_k.class != to_k.class {
        return Err(format!(
            "convert_units: cannot convert {} ({}) to {} ({})",
            from, from_k.class, to, to_k.class
        ));
    }

    let out = if from_k.class == UnitClass::Temperature {
        convert_temperature(value, from_k.name, to_k.name)?
    } else {
        // Each unit carries a factor relative to the class's base unit.
        // So: base = value * from.factor; output = base / to.factor.
        value * from_k.factor / to_k.factor
    };

    let rendered_in = format_number_f64(value);
    let rendered_out = format_number_f64(out);
    Ok(format!(
        "{rendered_in} {from} = {rendered_out} {to}",
        from = from_k.name,
        to = to_k.name,
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnitClass {
    Length,
    Mass,
    Temperature,
    Time,
    Speed,
    Data,
    Energy,
}

impl std::fmt::Display for UnitClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            UnitClass::Length => "length",
            UnitClass::Mass => "mass",
            UnitClass::Temperature => "temperature",
            UnitClass::Time => "time",
            UnitClass::Speed => "speed",
            UnitClass::Data => "data",
            UnitClass::Energy => "energy",
        };
        f.write_str(s)
    }
}

#[derive(Clone, Copy)]
struct UnitEntry {
    name: &'static str,
    class: UnitClass,
    /// Multiplier to convert this unit into the class's base unit.
    /// Ignored for Temperature, which uses `convert_temperature` instead.
    factor: f64,
}

fn canonical_unit(raw: &str) -> Option<UnitEntry> {
    let key = raw.trim().to_ascii_lowercase();
    // Table is small enough to keep as a simple match — that way all the
    // aliases live in one place and the compiler warns on duplicates.
    let out = match key.as_str() {
        // --- Length (base: meter) ---
        "m" | "meter" | "meters" | "metre" | "metres" =>
            UnitEntry { name: "m", class: UnitClass::Length, factor: 1.0 },
        "km" | "kilometer" | "kilometers" | "kilometre" | "kilometres" =>
            UnitEntry { name: "km", class: UnitClass::Length, factor: 1_000.0 },
        "cm" | "centimeter" | "centimeters" =>
            UnitEntry { name: "cm", class: UnitClass::Length, factor: 0.01 },
        "mm" | "millimeter" | "millimeters" =>
            UnitEntry { name: "mm", class: UnitClass::Length, factor: 0.001 },
        "nm" | "nanometer" | "nanometers" =>
            UnitEntry { name: "nm", class: UnitClass::Length, factor: 1e-9 },
        "mi" | "mile" | "miles" =>
            UnitEntry { name: "mi", class: UnitClass::Length, factor: 1_609.344 },
        "ft" | "foot" | "feet" =>
            UnitEntry { name: "ft", class: UnitClass::Length, factor: 0.3048 },
        "in" | "inch" | "inches" =>
            UnitEntry { name: "in", class: UnitClass::Length, factor: 0.0254 },
        "yd" | "yard" | "yards" =>
            UnitEntry { name: "yd", class: UnitClass::Length, factor: 0.9144 },

        // --- Mass (base: gram) ---
        "g" | "gram" | "grams" =>
            UnitEntry { name: "g", class: UnitClass::Mass, factor: 1.0 },
        "kg" | "kilogram" | "kilograms" =>
            UnitEntry { name: "kg", class: UnitClass::Mass, factor: 1_000.0 },
        "lb" | "lbs" | "pound" | "pounds" =>
            UnitEntry { name: "lb", class: UnitClass::Mass, factor: 453.59237 },
        "oz" | "ounce" | "ounces" =>
            UnitEntry { name: "oz", class: UnitClass::Mass, factor: 28.349523125 },
        "t" | "tonne" | "tonnes" | "metric_ton" =>
            UnitEntry { name: "t", class: UnitClass::Mass, factor: 1_000_000.0 },

        // --- Temperature (handled specially) ---
        "c" | "°c" | "celsius" =>
            UnitEntry { name: "C", class: UnitClass::Temperature, factor: 0.0 },
        "f" | "°f" | "fahrenheit" =>
            UnitEntry { name: "F", class: UnitClass::Temperature, factor: 0.0 },
        "k" | "kelvin" =>
            UnitEntry { name: "K", class: UnitClass::Temperature, factor: 0.0 },

        // --- Time (base: second) ---
        "s" | "sec" | "secs" | "second" | "seconds" =>
            UnitEntry { name: "s", class: UnitClass::Time, factor: 1.0 },
        "ms" | "millisecond" | "milliseconds" =>
            UnitEntry { name: "ms", class: UnitClass::Time, factor: 0.001 },
        "min" | "mins" | "minute" | "minutes" =>
            UnitEntry { name: "min", class: UnitClass::Time, factor: 60.0 },
        "h" | "hr" | "hrs" | "hour" | "hours" =>
            UnitEntry { name: "h", class: UnitClass::Time, factor: 3_600.0 },
        "d" | "day" | "days" =>
            UnitEntry { name: "d", class: UnitClass::Time, factor: 86_400.0 },
        "wk" | "week" | "weeks" =>
            UnitEntry { name: "wk", class: UnitClass::Time, factor: 604_800.0 },
        "yr" | "year" | "years" =>
            // 365.25 days — standard "Julian year" used in astronomy/legal.
            UnitEntry { name: "yr", class: UnitClass::Time, factor: 31_557_600.0 },

        // --- Speed (base: m/s) ---
        "mps" | "m/s" | "meter/s" | "meters/s" | "meters_per_second" =>
            UnitEntry { name: "mps", class: UnitClass::Speed, factor: 1.0 },
        "kph" | "km/h" | "kmh" | "kilometers_per_hour" =>
            UnitEntry { name: "kph", class: UnitClass::Speed, factor: 1_000.0 / 3_600.0 },
        "mph" | "mi/h" | "miles_per_hour" =>
            UnitEntry { name: "mph", class: UnitClass::Speed, factor: 1_609.344 / 3_600.0 },
        "knots" | "kt" | "kn" | "knot" =>
            UnitEntry { name: "knots", class: UnitClass::Speed, factor: 1_852.0 / 3_600.0 },
        "fps" | "ft/s" | "feet_per_second" =>
            UnitEntry { name: "fps", class: UnitClass::Speed, factor: 0.3048 },

        // --- Data (base: byte) ---
        "b" | "byte" | "bytes" =>
            UnitEntry { name: "B", class: UnitClass::Data, factor: 1.0 },
        "kb" | "kilobyte" | "kilobytes" =>
            UnitEntry { name: "kB", class: UnitClass::Data, factor: 1_000.0 },
        "mb" | "megabyte" | "megabytes" =>
            UnitEntry { name: "MB", class: UnitClass::Data, factor: 1_000_000.0 },
        "gb" | "gigabyte" | "gigabytes" =>
            UnitEntry { name: "GB", class: UnitClass::Data, factor: 1_000_000_000.0 },
        "tb" | "terabyte" | "terabytes" =>
            UnitEntry { name: "TB", class: UnitClass::Data, factor: 1_000_000_000_000.0 },
        "kib" | "kibibyte" | "kibibytes" =>
            UnitEntry { name: "KiB", class: UnitClass::Data, factor: 1_024.0 },
        "mib" | "mebibyte" | "mebibytes" =>
            UnitEntry { name: "MiB", class: UnitClass::Data, factor: 1_048_576.0 },
        "gib" | "gibibyte" | "gibibytes" =>
            UnitEntry { name: "GiB", class: UnitClass::Data, factor: 1_073_741_824.0 },
        "tib" | "tebibyte" | "tebibytes" =>
            UnitEntry { name: "TiB", class: UnitClass::Data, factor: 1_099_511_627_776.0 },

        // --- Energy (base: joule) ---
        "j" | "joule" | "joules" =>
            UnitEntry { name: "J", class: UnitClass::Energy, factor: 1.0 },
        "kj" | "kilojoule" | "kilojoules" =>
            UnitEntry { name: "kJ", class: UnitClass::Energy, factor: 1_000.0 },
        "cal" | "calorie" | "calories" =>
            UnitEntry { name: "cal", class: UnitClass::Energy, factor: 4.184 },
        "kcal" | "kilocalorie" | "kilocalories" =>
            UnitEntry { name: "kcal", class: UnitClass::Energy, factor: 4_184.0 },
        "wh" | "watt_hour" | "watt_hours" =>
            UnitEntry { name: "Wh", class: UnitClass::Energy, factor: 3_600.0 },
        "kwh" | "kilowatt_hour" | "kilowatt_hours" =>
            UnitEntry { name: "kWh", class: UnitClass::Energy, factor: 3_600_000.0 },

        _ => return None,
    };
    Some(out)
}

fn convert_temperature(value: f64, from: &str, to: &str) -> Result<f64, String> {
    // Normalise everything to Kelvin first, then convert out.
    let kelvin = match from {
        "C" => value + 273.15,
        "F" => (value - 32.0) * 5.0 / 9.0 + 273.15,
        "K" => value,
        other => return Err(format!("convert_units: unknown temperature unit \"{other}\"")),
    };
    let out = match to {
        "C" => kelvin - 273.15,
        "F" => (kelvin - 273.15) * 9.0 / 5.0 + 32.0,
        "K" => kelvin,
        other => return Err(format!("convert_units: unknown temperature unit \"{other}\"")),
    };
    Ok(out)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn convert_units_length() {
        let out = convert_units(1.0, "km".into(), "m".into()).await.unwrap();
        assert!(out.contains("1,000"), "got {out}");

        let out = convert_units(1.0, "mi".into(), "km".into()).await.unwrap();
        assert!(out.contains("1.609344"), "got {out}");
    }

    #[tokio::test]
    async fn convert_units_temperature() {
        let out = convert_units(100.0, "C".into(), "F".into()).await.unwrap();
        assert!(out.contains("212"), "got {out}");

        let out = convert_units(0.0, "C".into(), "K".into()).await.unwrap();
        assert!(out.contains("273.15"), "got {out}");
    }

    #[tokio::test]
    async fn convert_units_class_mismatch() {
        let err = convert_units(1.0, "km".into(), "kg".into()).await.unwrap_err();
        assert!(err.contains("cannot convert"), "got {err}");
    }

}

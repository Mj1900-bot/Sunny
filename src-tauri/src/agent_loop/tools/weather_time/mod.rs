//! Weather + time tools. Read-only external-read trust class;
//! capability `network.read` covers the Open-Meteo / timeapi.io calls.
pub mod sunrise_sunset;
pub mod time_in_city;
pub mod weather_current;
pub mod weather_forecast;

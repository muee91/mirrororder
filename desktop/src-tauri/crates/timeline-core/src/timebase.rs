//! A deliberately narrow FCPXML timebase adapter.
//!
//! Timeline Core remains the authority for editing state. This module only
//! reads the sequence metadata needed to seed a frame rate and exposes it
//! through the versioned `timebase.v1` JSON boundary. Python keeps its existing
//! implementation and orchestration until a later, separately reviewed cutover.
//! The v1 boundary is intentionally strict: it accepts UTF-8 FCPXML only and
//! fails closed on malformed XML rather than becoming a second XML authority.

use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::reader::NsReader;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const TIMEBASE_CONTRACT: &str = "timebase.v1";
pub const TIMEBASE_OPERATION: &str = "fcpxml_project_timebase";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TimebaseRequest {
    contract: String,
    operation: String,
    path: String,
}

#[derive(Debug)]
pub struct BoundaryError {
    pub code: &'static str,
    pub message: String,
}

impl BoundaryError {
    fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_request",
            message: message.into(),
        }
    }
}

/// Execute one `timebase.v1` request and return its versioned response.
///
/// The response deliberately wraps the legacy-compatible result under
/// `result`; callers can compare that object byte-for-byte after JSON parsing
/// without making the Python fallback's response schema part of the Rust
/// protocol's top level.
pub fn execute_request(input: &str) -> Result<Value, BoundaryError> {
    let request: TimebaseRequest = serde_json::from_str(input).map_err(|error| {
        BoundaryError::invalid_request(format!("request JSON is invalid: {error}"))
    })?;
    if request.contract != TIMEBASE_CONTRACT {
        return Err(BoundaryError::invalid_request(format!(
            "unsupported contract: expected {TIMEBASE_CONTRACT}"
        )));
    }
    if request.operation != TIMEBASE_OPERATION {
        return Err(BoundaryError::invalid_request(format!(
            "unsupported operation: expected {TIMEBASE_OPERATION}"
        )));
    }
    Ok(json!({
        "contract": TIMEBASE_CONTRACT,
        "result": fcpxml_project_timebase(Path::new(&request.path)),
    }))
}

/// Return the same fail-closed status object as Python's `fcpxml_project_timebase`.
pub fn fcpxml_project_timebase(path: &Path) -> Value {
    if !path.is_file() {
        return unknown("source_missing", None);
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return unknown("parse_failed", None),
    };
    match parse_fcpxml(&bytes) {
        Ok(parsed) => parsed,
        Err(()) => unknown("parse_failed", None),
    }
}

fn unknown(reason: &str, format_id: Option<&str>) -> Value {
    let mut result = serde_json::Map::new();
    result.insert("status".to_string(), json!("unknown"));
    result.insert("source".to_string(), json!("fcpxml_sequence"));
    result.insert("reason".to_string(), json!(reason));
    if let Some(format_id) = format_id {
        result.insert("format_id".to_string(), json!(format_id));
    }
    Value::Object(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rational {
    numerator: i128,
    denominator: i128,
}

impl Rational {
    fn new(numerator: i128, denominator: i128) -> Option<Self> {
        if denominator == 0 {
            return None;
        }
        let sign = if denominator < 0 { -1 } else { 1 };
        let numerator = numerator.checked_mul(sign)?;
        let denominator = denominator.checked_mul(sign)?;
        let divisor = gcd(numerator.unsigned_abs(), denominator.unsigned_abs()) as i128;
        Some(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    fn canonical(self) -> String {
        format!("{}/{}s", self.numerator, self.denominator)
    }

    fn fits_timeline_frame_rate(self) -> bool {
        self.numerator > 0
            && self.denominator > 0
            && self.numerator <= i128::from(u32::MAX)
            && self.denominator <= i128::from(u32::MAX)
    }
}

fn gcd(mut left: u128, mut right: u128) -> u128 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    // A zero numerator is valid as an intermediate parser result, even though
    // the timebase resolver rejects non-positive durations below.
    left.max(1)
}

fn parse_time(value: &str) -> Option<Rational> {
    let raw = value.trim().trim_end_matches('s');
    if raw.is_empty() {
        return None;
    }
    let parsed = if let Some((left, right)) = raw.split_once('/') {
        if right.contains('/') {
            return None;
        }
        let numerator = parse_integer(left)?;
        let denominator = parse_integer(right)?;
        Rational::new(numerator, denominator)?
    } else {
        parse_decimal(raw)?
    };
    (parsed.numerator > 0).then_some(parsed)
}

/// Parse the decimal/integer subset accepted by Python's `Fraction(str)`.
/// Keeping all arithmetic in i128 makes overflow explicit and fail-closed at
/// this boundary instead of silently narrowing to Timeline Core's u32 rate.
fn parse_decimal(value: &str) -> Option<Rational> {
    let (mantissa, exponent) = match value.find(['e', 'E']) {
        Some(position) => (
            &value[..position],
            parse_integer(&value[position + 1..])?.try_into().ok()?,
        ),
        None => (value, 0_i32),
    };
    let (sign, unsigned) = match mantissa.as_bytes().first().copied() {
        Some(b'+') => (1_i128, &mantissa[1..]),
        Some(b'-') => (-1_i128, &mantissa[1..]),
        _ => (1_i128, mantissa),
    };
    if unsigned.is_empty() || unsigned.matches('.').count() > 1 {
        return None;
    }
    let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let integer = clean_digits(integer)?;
    let fraction = clean_digits(fraction)?;
    if integer.is_empty() && fraction.is_empty() {
        return None;
    }
    let digits = format!("{integer}{fraction}");
    let mut numerator = digits.parse::<i128>().ok()?.checked_mul(sign)?;
    let mut denominator = pow10(fraction.len() as u32)?;
    if exponent >= 0 {
        numerator = numerator.checked_mul(pow10(exponent as u32)?)?;
    } else {
        denominator = denominator.checked_mul(pow10(exponent.unsigned_abs())?)?;
    }
    Rational::new(numerator, denominator)
}

fn parse_integer(value: &str) -> Option<i128> {
    let value = value.trim();
    let (sign, unsigned) = match value.as_bytes().first().copied() {
        Some(b'+') => (1_i128, &value[1..]),
        Some(b'-') => (-1_i128, &value[1..]),
        _ => (1_i128, value),
    };
    let digits = clean_digits(unsigned)?;
    digits.parse::<i128>().ok()?.checked_mul(sign)
}

fn clean_digits(value: &str) -> Option<String> {
    if value.is_empty() {
        return Some(String::new());
    }
    let bytes = value.as_bytes();
    if value.starts_with('_') || value.ends_with('_') || value.contains("__") {
        return None;
    }
    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_digit() || *byte == b'_')
    {
        return None;
    }
    if value.match_indices('_').any(|(position, _)| {
        position == 0
            || position + 1 >= bytes.len()
            || !bytes[position - 1].is_ascii_digit()
            || !bytes[position + 1].is_ascii_digit()
    }) {
        return None;
    }
    Some(value.replace('_', ""))
}

fn pow10(exponent: u32) -> Option<i128> {
    let mut result = 1_i128;
    for _ in 0..exponent {
        result = result.checked_mul(10)?;
    }
    Some(result)
}

fn parse_fcpxml(bytes: &[u8]) -> Result<Value, ()> {
    let bytes = validate_utf8_source(bytes)?;
    if contains_invalid_xml_control(bytes) {
        return Err(());
    }
    let mut reader = NsReader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = true;
    reader.config_mut().check_comments = true;
    let mut buffer = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut formats: BTreeMap<String, Rational> = BTreeMap::new();
    let mut project_sequences: Vec<Option<String>> = Vec::new();
    let mut project_ancestry: Vec<usize> = Vec::new();
    let mut root_seen = false;
    let mut document_closed = false;
    let mut declaration_seen = false;
    let mut prolog_open = true;

    loop {
        let (namespace, event) = match reader.read_resolved_event_into(&mut buffer) {
            Ok(event) => event,
            Err(_) => return Err(()),
        };
        if matches!(namespace, ResolveResult::Unknown(_)) {
            return Err(());
        }
        match event {
            Event::Start(element) => {
                if document_closed || (stack.is_empty() && root_seen) {
                    return Err(());
                }
                if stack.is_empty() {
                    root_seen = true;
                    prolog_open = false;
                }
                let name = element.local_name().as_ref().to_vec();
                let attributes = attributes(&element, reader.resolver())?;
                if name == b"format" {
                    if let (Some(id), Some(frame_duration)) =
                        (attributes.get("id"), attributes.get("frameDuration"))
                    {
                        if !id.is_empty() {
                            if let Some(duration) = parse_time(frame_duration) {
                                // Match ElementTree's last-valid-duplicate behavior.
                                formats.insert(id.clone(), duration);
                            }
                        }
                    }
                } else if name == b"project" {
                    let project_index = project_sequences.len();
                    project_sequences.push(None);
                    project_ancestry.push(project_index);
                } else if name == b"sequence" {
                    let sequence_format = attributes.get("format").cloned().unwrap_or_default();
                    for project_index in project_ancestry.iter().copied() {
                        if project_sequences[project_index].is_none() {
                            project_sequences[project_index] = Some(sequence_format.clone());
                        }
                    }
                }
                stack.push(name);
            }
            Event::Empty(element) => {
                if document_closed || (stack.is_empty() && root_seen) {
                    return Err(());
                }
                if stack.is_empty() {
                    root_seen = true;
                    document_closed = true;
                    prolog_open = false;
                }
                let name = element.local_name().as_ref().to_vec();
                let attributes = attributes(&element, reader.resolver())?;
                if name == b"format" {
                    if let (Some(id), Some(frame_duration)) =
                        (attributes.get("id"), attributes.get("frameDuration"))
                    {
                        if !id.is_empty() {
                            if let Some(duration) = parse_time(frame_duration) {
                                formats.insert(id.clone(), duration);
                            }
                        }
                    }
                } else if name == b"project" {
                    // Empty projects cannot contain a sequence descendant.
                } else if name == b"sequence" {
                    let sequence_format = attributes.get("format").cloned().unwrap_or_default();
                    for project_index in project_ancestry.iter().copied() {
                        if project_sequences[project_index].is_none() {
                            project_sequences[project_index] = Some(sequence_format.clone());
                        }
                    }
                }
            }
            Event::End(element) => {
                let name = element.local_name().as_ref().to_vec();
                let Some(open) = stack.pop() else {
                    return Err(());
                };
                if open != name {
                    return Err(());
                }
                if name == b"project" {
                    if project_ancestry.pop().is_none() {
                        return Err(());
                    }
                }
                if stack.is_empty() {
                    document_closed = true;
                }
            }
            Event::Text(text) => {
                if stack.is_empty() {
                    prolog_open = false;
                }
                if stack.is_empty() && !is_xml_whitespace(text.as_ref()) {
                    return Err(());
                }
            }
            Event::CData(text) => {
                if stack.is_empty() {
                    prolog_open = false;
                }
                if stack.is_empty() && !is_xml_whitespace(text.as_ref()) {
                    return Err(());
                }
            }
            Event::GeneralRef(reference) => {
                // A character/entity reference outside the document element is
                // never ignorable XML whitespace, so match ElementTree's
                // parse failure rather than silently accepting trailing junk.
                if stack.is_empty() || !valid_character_reference(reference.as_ref()) {
                    return Err(());
                }
            }
            Event::Decl(declaration) => {
                if root_seen || declaration_seen || !prolog_open {
                    return Err(());
                }
                declaration_seen = true;
                if let Some(encoding) = declaration.encoding() {
                    let encoding = encoding.map_err(|_| ())?;
                    if !encoding.eq_ignore_ascii_case(b"utf-8") {
                        return Err(());
                    }
                }
            }
            Event::Comment(_) => {
                if stack.is_empty() {
                    prolog_open = false;
                }
            }
            Event::PI(_) if root_seen => return Err(()),
            Event::PI(_) => {
                if stack.is_empty() {
                    prolog_open = false;
                }
            }
            Event::DocType(_) if root_seen => return Err(()),
            Event::DocType(_) => {
                if stack.is_empty() {
                    prolog_open = false;
                }
            }
            Event::Eof => break,
        }
        buffer.clear();
    }
    if !root_seen || !stack.is_empty() || !document_closed {
        return Err(());
    }

    let Some(sequence_format) = project_sequences.into_iter().flatten().next() else {
        return Ok(unknown("project_sequence_missing", None));
    };
    let Some(frame_duration) = formats.get(&sequence_format).copied() else {
        return Ok(unknown("sequence_format_missing", Some(&sequence_format)));
    };
    let Some(frame_rate) = Rational::new(frame_duration.denominator, frame_duration.numerator)
    else {
        return Ok(unknown("sequence_format_missing", Some(&sequence_format)));
    };
    if !frame_rate.fits_timeline_frame_rate() {
        return Ok(unknown("timebase_overflow", Some(&sequence_format)));
    }
    Ok(json!({
        "status": "confirmed",
        "source": "fcpxml_sequence",
        "format_id": sequence_format,
        "frame_duration": frame_duration.canonical(),
        "numerator": frame_rate.numerator,
        "denominator": frame_rate.denominator,
    }))
}

fn is_xml_whitespace(value: &[u8]) -> bool {
    value
        .iter()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
}

fn contains_invalid_xml_control(value: &[u8]) -> bool {
    value
        .iter()
        .any(|byte| matches!(byte, 0x00..=0x08 | 0x0b..=0x0c | 0x0e..=0x1f))
}

fn validate_utf8_source(value: &[u8]) -> Result<&[u8], ()> {
    if value.starts_with(&[0xff, 0xfe]) || value.starts_with(&[0xfe, 0xff]) {
        return Err(());
    }
    let value = value.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(value);
    std::str::from_utf8(value).map_err(|_| ())?;
    Ok(value)
}

fn valid_character_reference(value: &[u8]) -> bool {
    // ElementTree resolves only XML's five predefined entities unless a DTD
    // declares additional entities. The timebase boundary intentionally does
    // not process DTD declarations, so reject every other named reference.
    if value.first() != Some(&b'#') {
        return matches!(value, b"amp" | b"lt" | b"gt" | b"apos" | b"quot");
    }
    let (digits, radix) = if value.get(1) == Some(&b'x') || value.get(1) == Some(&b'X') {
        (&value[2..], 16)
    } else {
        (&value[1..], 10)
    };
    let Ok(digits) = std::str::from_utf8(digits) else {
        return false;
    };
    let Ok(codepoint) = u32::from_str_radix(digits, radix) else {
        return false;
    };
    matches!(
        codepoint,
        0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff
    )
}

fn attributes<'a>(
    element: &quick_xml::events::BytesStart<'a>,
    resolver: &quick_xml::name::NamespaceResolver,
) -> Result<BTreeMap<String, String>, ()> {
    let mut result = BTreeMap::new();
    let mut attributes = element.attributes();
    attributes.with_checks(true);
    let decoder = attributes.decoder();
    for attribute in attributes {
        let attribute = attribute.map_err(|_| ())?;
        if !is_namespace_declaration(attribute.key)
            && matches!(
                resolver.resolve_attribute(attribute.key).0,
                ResolveResult::Unknown(_)
            )
        {
            return Err(());
        }
        let key = std::str::from_utf8(attribute.key.as_ref()).map_err(|_| ())?;
        let value = attribute
            .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
            .map_err(|_| ())?
            .into_owned();
        result.insert(key.to_string(), value);
    }
    Ok(result)
}

fn is_namespace_declaration(name: quick_xml::name::QName<'_>) -> bool {
    name.as_ref() == b"xmlns" || name.as_ref().starts_with(b"xmlns:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parse(xml: &str) -> Value {
        parse_fcpxml(xml.as_bytes()).unwrap()
    }

    #[test]
    fn preserves_ntsc_rational_rate_and_namespace() {
        let result = parse(
            r#"<fcpxml xmlns="urn:fcpxml"><resources><format id="r1" frameDuration="1001/24000s"/></resources><library><event><project><sequence format="r1"/></project></event></library></fcpxml>"#,
        );
        assert_eq!(result["numerator"], 24000);
        assert_eq!(result["denominator"], 1001);
        assert_eq!(result["frame_duration"], "1001/24000s");
    }

    #[test]
    fn duplicate_formats_keep_last_valid_value() {
        let result = parse(
            r#"<fcpxml><resources><format id="r1" frameDuration="1/25s"/><format id="r1" frameDuration="bad"/><format id="r1" frameDuration="1/50s"/></resources><library><event><project><sequence format="r1"/></project></event></library></fcpxml>"#,
        );
        assert_eq!(result["numerator"], 50);
        assert_eq!(result["denominator"], 1);
    }

    #[test]
    fn malformed_xml_and_missing_sequence_fail_closed() {
        assert_eq!(parse_fcpxml(b"<fcpxml>").unwrap_err(), ());
        let result = parse("<fcpxml><library><event><project/></event></library></fcpxml>");
        assert_eq!(result["reason"], "project_sequence_missing");
    }

    #[test]
    fn strict_utf8_boundary_rejects_processing_instructions_mid_document() {
        assert!(parse_fcpxml(b"<fcpxml><?pi?></fcpxml>").is_err());
        assert!(parse_fcpxml(b"<fcpxml/><?pi?>").is_err());
        assert!(parse_fcpxml(b"<fcpxml/><?xml version=\"1.0\"?>").is_err());
    }

    #[test]
    fn strict_utf8_boundary_accepts_utf8_bom_and_rejects_utf16_bytes() {
        let mut utf8 = b"\xef\xbb\xbf<fcpxml/>".to_vec();
        assert_eq!(
            parse_fcpxml(&utf8).unwrap()["reason"],
            "project_sequence_missing"
        );
        utf8[0] = 0xff;
        utf8[1] = 0xfe;
        assert!(parse_fcpxml(&utf8).is_err());
    }

    #[test]
    fn entity_references_match_elementtree_rules() {
        let valid = parse(
            r#"<fcpxml><resources><format id="r1" frameDuration="1/25s"/></resources><library><event><project><sequence format="r1"/>text &amp; &#65; &#x41; &lt; &gt; &apos; &quot;</project></event></library></fcpxml>"#,
        );
        assert_eq!(valid["status"], "confirmed");

        let invalid = br#"<fcpxml><resources><format id="r1" frameDuration="1/25s"/></resources><library><event><project><sequence format="r1"/>text &undefined;</project></event></library></fcpxml>"#;
        assert!(parse_fcpxml(invalid).is_err());
    }

    #[test]
    fn request_boundary_is_versioned() {
        let path = PathBuf::from("/path/that/does/not/exist");
        let request = format!(
            r#"{{"contract":"timebase.v1","operation":"fcpxml_project_timebase","path":"{}"}}"#,
            path.display()
        );
        let response = execute_request(&request).unwrap();
        assert_eq!(response["contract"], TIMEBASE_CONTRACT);
        assert_eq!(response["result"]["reason"], "source_missing");
    }

    #[test]
    fn frame_rate_overflow_fails_closed_before_json_narrowing() {
        let result = parse(
            "<fcpxml><resources><format id=\"r1\" frameDuration=\"1/4294967296s\"/></resources><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
        );
        assert_eq!(result["status"], "unknown");
        assert_eq!(result["reason"], "timebase_overflow");
    }
}

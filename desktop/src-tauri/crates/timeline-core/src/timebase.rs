//! A deliberately narrow FCPXML timebase adapter.
//!
//! Timeline Core remains the authority for editing state. This module only
//! reads the sequence metadata needed to seed a frame rate and exposes it
//! through the versioned `timebase.v1` JSON boundary. Python keeps its existing
//! implementation and orchestration until a later, separately reviewed cutover.
//! The v1 boundary is intentionally strict: it accepts UTF-8 FCPXML only and
//! fails closed on malformed XML rather than becoming a second XML authority.
//! DTD internal declarations are unsupported: ignoring their entities or
//! default attributes could silently change the sequence metadata we resolve.
//! Special-node names are limited to ASCII; Unicode element content and
//! metadata remain supported without duplicating Expat's Unicode name tables.

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
    if contains_invalid_xml_character(bytes) {
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
    let mut doctype_seen = false;
    let mut prolog_open = true;

    loop {
        let event_start = reader.buffer_position() as usize;
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
            Event::CData(_) => {
                // CDATA is element content, even when empty or whitespace-only.
                if stack.is_empty() {
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
                validate_declaration(declaration.as_ref())?;
            }
            Event::Comment(_) => {
                if stack.is_empty() {
                    prolog_open = false;
                }
            }
            Event::PI(instruction) => {
                // ElementTree ignores valid PIs before, inside and after the
                // root. Their content is opaque, not an XML attribute list.
                let target = std::str::from_utf8(instruction.target()).map_err(|_| ())?;
                if target.eq_ignore_ascii_case("xml") || !valid_supported_ncname(target) {
                    return Err(());
                }
                if stack.is_empty() {
                    prolog_open = false;
                }
            }
            Event::DocType(doctype) => {
                if root_seen || doctype_seen {
                    return Err(());
                }
                // quick-xml tokenizes even lowercase DOCTYPE and does not
                // validate its payload. Check the original spelling too.
                let source = bytes.get(event_start..).ok_or(())?;
                if !source.starts_with(b"<!DOCTYPE")
                    || !source
                        .get(9)
                        .is_some_and(|byte| is_xml_whitespace(&[*byte]))
                {
                    return Err(());
                }
                validate_doctype(doctype.as_ref())?;
                doctype_seen = true;
                prolog_open = false;
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

fn skip_xml_whitespace(value: &mut &[u8]) -> bool {
    let before = value.len();
    *value = value.trim_ascii_start();
    // Other ASCII whitespace is already rejected by contains_invalid_xml_character.
    value.len() != before
}

fn take_quoted_value<'a>(value: &mut &'a [u8]) -> Result<&'a [u8], ()> {
    let quote = *value.first().ok_or(())?;
    if !matches!(quote, b'\'' | b'"') {
        return Err(());
    }
    let end = value[1..]
        .iter()
        .position(|byte| *byte == quote)
        .ok_or(())?
        + 1;
    let content = &value[1..end];
    *value = &value[end + 1..];
    Ok(content)
}

fn validate_declaration(value: &[u8]) -> Result<(), ()> {
    let mut remaining = value.strip_prefix(b"xml").ok_or(())?;
    let mut next_attribute = 0;
    loop {
        let separated = skip_xml_whitespace(&mut remaining);
        if remaining.is_empty() {
            return (next_attribute != 0).then_some(()).ok_or(());
        }
        if !separated {
            return Err(());
        }
        let name_end = remaining
            .iter()
            .position(|byte| !byte.is_ascii_alphabetic())
            .ok_or(())?;
        let name = &remaining[..name_end];
        remaining = &remaining[name_end..];
        skip_xml_whitespace(&mut remaining);
        remaining = remaining.strip_prefix(b"=").ok_or(())?;
        skip_xml_whitespace(&mut remaining);
        let content = take_quoted_value(&mut remaining)?;
        next_attribute = match name {
            b"version" if next_attribute == 0 => {
                // Match Expat's declaration token rules. Version does not
                // change the XML 1.0 character rules used by this adapter.
                if content.is_empty()
                    || !content.iter().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
                {
                    return Err(());
                }
                1
            }
            b"encoding" if next_attribute == 1 => {
                if !content.eq_ignore_ascii_case(b"utf-8") {
                    return Err(());
                }
                2
            }
            b"standalone" if matches!(next_attribute, 1 | 2) => {
                if !matches!(content, b"yes" | b"no") {
                    return Err(());
                }
                3
            }
            _ => return Err(()),
        };
    }
}

fn validate_doctype(value: &[u8]) -> Result<(), ()> {
    let name_end = value
        .iter()
        .position(|byte| is_xml_whitespace(&[*byte]) || *byte == b'[')
        .unwrap_or(value.len());
    let name = std::str::from_utf8(&value[..name_end]).map_err(|_| ())?;
    if name.split(':').count() > 2 || !name.split(':').all(valid_supported_ncname) {
        return Err(());
    }
    let mut remaining = &value[name_end..];
    let separated = skip_xml_whitespace(&mut remaining);
    if !remaining.is_empty() && remaining[0] != b'[' {
        if !separated {
            return Err(());
        }
        let public = remaining.starts_with(b"PUBLIC");
        remaining = remaining
            .strip_prefix(if public { b"PUBLIC" } else { b"SYSTEM" })
            .ok_or(())?;
        if !skip_xml_whitespace(&mut remaining) {
            return Err(());
        }
        if public {
            let public_id = take_quoted_value(&mut remaining)?;
            if !public_id.iter().all(|byte| {
                byte.is_ascii_alphanumeric() || b" \r\n-'()+,./:=?;!*#@$_%".contains(byte)
            }) || !skip_xml_whitespace(&mut remaining)
            {
                return Err(());
            }
        }
        // External identifiers are syntax only. Never fetch or read a DTD.
        take_quoted_value(&mut remaining)?;
        skip_xml_whitespace(&mut remaining);
    }
    if let Some(subset) = remaining.strip_prefix(b"[") {
        remaining = subset;
        skip_xml_whitespace(&mut remaining);
        // Non-empty internal subsets can alter attributes/entities. Reject
        // rather than accepting a document with different Python semantics.
        remaining = remaining.strip_prefix(b"]").ok_or(())?;
        skip_xml_whitespace(&mut remaining);
    }
    remaining.is_empty().then_some(()).ok_or(())
}

fn valid_supported_ncname(value: &str) -> bool {
    // XML fifth-edition Unicode names are broader than ElementTree/Expat's
    // accepted set. Keep this metadata-only boundary conservative instead of
    // claiming parity with a different XML grammar or copying Unicode tables.
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn contains_invalid_xml_character(value: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(value) else {
        return true;
    };
    // Tokenizers do not necessarily inspect opaque PI/comment/CDATA payloads.
    // Validate every literal scalar, including the forbidden U+FFFE/U+FFFF.
    text.chars()
        .any(|character| !valid_xml_character(character as u32))
}

fn valid_xml_character(codepoint: u32) -> bool {
    matches!(
        codepoint,
        0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff
    )
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
    valid_xml_character(codepoint)
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
    fn processing_instructions_are_ignored_at_every_document_position() {
        assert!(parse_fcpxml(b"<?pi?><fcpxml><?pi data &not-an-entity;?></fcpxml><?pi?>").is_ok());
        assert!(parse_fcpxml(b"<fcpxml/><?xml version=\"1.0\"?>").is_err());
        for xml in [
            "<??><fcpxml/>",
            "<?XML?><fcpxml/>",
            "<fcpxml><?9bad?></fcpxml>",
        ] {
            assert!(parse_fcpxml(xml.as_bytes()).is_err(), "{xml}");
        }
    }

    #[test]
    fn cdata_is_only_allowed_inside_the_document_element() {
        assert!(parse_fcpxml(b"<fcpxml><![CDATA[<text>&literal;</text>]]></fcpxml>").is_ok());
        for xml in [
            "<![CDATA[]]><fcpxml/>",
            "<![CDATA[ ]]><fcpxml/>",
            "<fcpxml/><![CDATA[ ]]>",
        ] {
            assert!(parse_fcpxml(xml.as_bytes()).is_err(), "{xml}");
        }
    }

    #[test]
    fn illegal_unicode_is_rejected_even_in_opaque_xml_payloads() {
        for character in ['\u{fffe}', '\u{ffff}'] {
            for xml in [
                format!("<fcpxml><?editor {character}?></fcpxml>"),
                format!("<fcpxml><![CDATA[{character}]]></fcpxml>"),
                format!("<fcpxml><!-- {character} --></fcpxml>"),
                format!("<fcpxml note='{character}'/>"),
            ] {
                assert!(parse_fcpxml(xml.as_bytes()).is_err(), "{xml:?}");
            }
        }
    }

    #[test]
    fn declaration_requires_ordered_unique_pseudo_attributes() {
        assert!(
            parse_fcpxml(b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?><fcpxml/>")
                .is_ok()
        );
        for declaration in [
            "<?xml?>",
            "<?xml encoding='UTF-8'?>",
            "<?xml version='1.0' extra='yes'?>",
            "<?xml version='1.0' version='1.0'?>",
            "<?xml version='1.0'encoding='UTF-8'?>",
            "<?xml version='1.0' standalone='true'?>",
            "<?xml version='1.0' standalone='yes' encoding='UTF-8'?>",
        ] {
            let xml = format!("{declaration}<fcpxml/>");
            assert!(parse_fcpxml(xml.as_bytes()).is_err(), "{xml}");
        }
    }

    #[test]
    fn doctype_is_validated_once_and_never_expands_internal_declarations() {
        for declaration in [
            "<!DOCTYPE fcpxml>",
            "<!DOCTYPE fcpxml SYSTEM 'unused.dtd'>",
            "<!DOCTYPE fcpxml PUBLIC '-//Example//DTD FCPXML//EN' 'unused.dtd' []>",
        ] {
            let xml = format!("{declaration}<fcpxml/>");
            assert!(parse_fcpxml(xml.as_bytes()).is_ok(), "{xml}");
        }
        for xml in [
            "<!DOCTYPE fcpxml><!DOCTYPE fcpxml><fcpxml/>",
            "<!doctype fcpxml><fcpxml/>",
            "<!DOCTYPEfcpxml><fcpxml/>",
            "<!DOCTYPE fcpxml garbage><fcpxml/>",
            "<!DOCTYPE fcpxml PUBLIC 'id'><fcpxml/>",
            "<!DOCTYPE fcpxml [<!ENTITY custom 'value'>]><fcpxml/>",
            "<fcpxml><!DOCTYPE fcpxml></fcpxml>",
            "<fcpxml/><!DOCTYPE fcpxml>",
        ] {
            assert!(parse_fcpxml(xml.as_bytes()).is_err(), "{xml}");
        }
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

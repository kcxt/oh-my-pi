//! Snapshot-tag mismatch diagnostics.

use std::sync::LazyLock;

use regex::Regex;

use super::{
	format::HL_FILE_HASH_EXAMPLES,
	messages::{format_anchored_context, json_quote},
};
use crate::error::{EditError, Rejection};

static LINE_REF_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*[>+\-*]*\s*(\d+)(?::.*)?\s*$").expect("valid regex"));

/// Context needed to explain a stale or unrecognized snapshot tag.
pub struct MismatchDetails {
	pub path:               Option<String>,
	pub expected_file_hash: String,
	pub actual_file_hash:   String,
	pub file_lines:         Vec<String>,
	pub anchor_lines:       Vec<u32>,
	pub hash_recognized:    bool,
	/// Absolute paths this session has already issued `expected_file_hash` for.
	/// Non-empty when `hash_recognized` is false and the tag belongs to a
	/// different file in the same session — e.g. a worktree lane that pasted a
	/// parent-checkout tag into its own (correctly) relative header.
	pub tag_origin_paths:   Vec<String>,
}

/// Format the required shape of a tagged line anchor.
pub fn format_full_anchor_requirement(raw: Option<&str>) -> String {
	let received = raw.map_or_default(|value| format!(" Received {}.", json_quote(value)));
	format!(
		"a bare line number from read/search output plus the section header content-hash tag (for \
		 example [src/foo.ts#{}] and line \"160\"){received}",
		HL_FILE_HASH_EXAMPLES[0]
	)
}

/// Parse a decorated bare line-number reference.
pub fn parse_tag(reference: &str) -> Result<u32, EditError> {
	let Some(captures) = LINE_REF_RE.captures(reference) else {
		return Err(EditError::parse(format!(
			"Invalid line reference. Expected {}.",
			format_full_anchor_requirement(Some(reference))
		)));
	};
	let line = captures[1].parse::<u32>().map_err(|_| {
		EditError::parse(format!(
			"Invalid line reference. Expected {}.",
			format_full_anchor_requirement(Some(reference))
		))
	})?;
	if line < 1 {
		return Err(EditError::parse(format!(
			"Line number must be >= 1, got {line} in \"{reference}\"."
		)));
	}
	Ok(line)
}

/// Validate that a line reference exists in the target.
pub fn validate_line_ref(line: u32, file_lines: &[String]) -> Result<(), EditError> {
	if line < 1 || usize::try_from(line).map_or(true, |line| line > file_lines.len()) {
		return Err(EditError::matched(format!(
			"Line {line} does not exist (file has {} lines)",
			file_lines.len()
		)));
	}
	Ok(())
}

/// Format the complete model-facing snapshot mismatch diagnostic.
pub fn format_mismatch_message(details: &MismatchDetails) -> String {
	let path = details
		.path
		.as_ref()
		.map_or_default(|path| format!(" for {path}"));
	let expected = &details.expected_file_hash;
	let actual = &details.actual_file_hash;
	let mut lines = if details.hash_recognized {
		vec![format!(
			"Edit rejected{path}: the file changed since tag #{expected} (now #{actual}). If your \
			 own edit changed it, use the header from that edit's response; otherwise re-read."
		)]
	} else if expected.is_empty() {
		vec![format!(
			"Edit rejected{path}: the header has no tag. Read the file and copy its [path#TAG] \
			 header (current tag #{actual})."
		)]
	} else if details.tag_origin_paths.is_empty() {
		vec![format!(
			"Edit rejected{path}: tag #{expected} was not issued for this file in this session. Read \
			 the file and copy its [path#TAG] header (current tag #{actual})."
		)]
	} else {
		// Name the files the tag was issued for, so a lane that pasted a tag from
		// a sibling checkout does not follow it into a wrong-tree write.
		details
			.tag_origin_paths
			.iter()
			.map(|origin| {
				format!(
					"Edit rejected{path}: tag #{expected} belongs to {origin}. Check you are editing \
					 the intended file; this file's current tag is #{actual}."
				)
			})
			.collect()
	};
	let context = format_anchored_context(&details.anchor_lines, &details.file_lines);
	if !context.is_empty() {
		lines.push(String::new());
		lines.extend(context);
	}
	lines.join("\n")
}

/// Diagnostic for input whose only content is a section header: no ops to
/// apply, but the file's current tag, as an unknown tag would get.
pub fn format_header_only_message(path: &str, actual_file_hash: &str) -> String {
	format!(
		"Edit rejected for {path}: no ops under the header (current tag #{actual_file_hash}). \
		 Example: `PUT 12.=14:` followed by `+` lines replaces lines 12–14; `CUT 3.=4` deletes \
		 lines 3–4."
	)
}

/// Construct a tag rejection from mismatch details.
pub fn mismatch_error(details: &MismatchDetails) -> EditError {
	let reason = if details.hash_recognized {
		Rejection::StaleTag
	} else if details.expected_file_hash.is_empty() {
		Rejection::MissingTag
	} else if details.tag_origin_paths.is_empty() {
		Rejection::UnknownTag
	} else {
		Rejection::OtherFileTag
	};
	EditError::rejected(reason, format_mismatch_message(details))
}

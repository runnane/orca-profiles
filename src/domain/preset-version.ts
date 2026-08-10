/**
 * The `version` gate on user presets.
 *
 * `PresetCollection::load_presets` reads a user preset's `version`, parses it, and
 * **silently drops the preset** when the parse fails:
 *
 * ```cpp
 * std::string version_str = key_values[BBL_JSON_KEY_VERSION];
 * boost::optional<Semver> version = Semver::parse(version_str);
 * if (!version) continue;
 * ```
 * — v2.4.2 Preset.cpp:1653-1655
 *
 * No log line and no `++m_errors`, which is why a config where this happens looks
 * intact from the outside: the file is on disk, the slicer never loaded it, and
 * nothing anywhere says so. A dropped preset is also unavailable as a parent, so
 * one of these takes its whole subtree with it — see `notLoadedPresets`.
 *
 * The string is empty when the key is **absent**, not defaulted: `key_values` only
 * gains a `version` entry inside the `iequals(it.key(), BBL_JSON_KEY_VERSION)`
 * branch (`ConfigBase::load_from_json`, Config.cpp:885-887), so `std::map`'s
 * `operator[]` default-constructs `""` — and `""` does not parse. A user preset
 * with no `version` key at all is therefore never loaded.
 *
 * **User presets only.** System presets come in through `parse_subfile`
 * (PresetBundle.cpp:4836+), which reads `version` from the vendor index and has no
 * equivalent gate, so this rule must not be applied to them.
 *
 * Everything below is a port of the parser the slicer actually links, not of the
 * semver spec — the two disagree, and it is the former that decides.
 */

/** `VALID_CHARS` = `NUMBERS ALPHA DELIMITERS`, semver.c:13-22. */
const VALID_CHARS = /^[0-9A-Za-z.+-]*$/;
/** `MAX_SIZE`, semver.c:22. */
const MAX_SIZE = 255;
/** `SLICE_SIZE`, semver.c:13. */
const SLICE_SIZE = 50;

/**
 * Would `::semver_parse` accept this string?
 *
 * ```c
 * valid = semver_is_valid(str);      // length + charset
 * if (!valid) return -1;
 * ver->metadata   = parse_slice(buf, '+');
 * ver->prerelease = parse_slice(buf, '-');
 * res = semver_parse_version(buf, ver);
 * ```
 * — semver.c:141-160
 *
 * `parse_slice` truncates the buffer at the first occurrence of its delimiter, so
 * metadata is cut before prerelease and only the numeric head reaches
 * `semver_parse_version`.
 *
 * That function walks at most four `.`-separated slices, requires `strtol` to
 * consume each one whole, and ends on:
 *
 * ```c
 * // Major and minor versions are mandatory, patch version is not mandatory.
 * return (index == 2 || index == 3 || index == 4) ? 0 : -1;
 * ```
 * — semver.c:212-213
 *
 * `index` counts iterations, so **two to four numeric components are required**:
 * `""` and `"1"` fail, `"1.9"` passes, and the fourth component is an Orca
 * addition folded into `patch` (semver.c:200-201). The 5th and later components
 * are not rejected — the loop simply stops at four — so `"1.2.3.4.5"` parses.
 */
export function parsesAsSemver(text: string): boolean {
  // semver_is_valid: has_valid_length && has_valid_chars (semver.c:564-568).
  if (text.length > MAX_SIZE) return false;
  if (!VALID_CHARS.test(text)) return false;

  // parse_slice(buf, '+') then parse_slice(buf, '-'), in that order (semver.c:154-155).
  let head = text;
  const plus = head.indexOf('+');
  if (plus !== -1) head = head.slice(0, plus);
  const dash = head.indexOf('-');
  if (dash !== -1) head = head.slice(0, dash);

  // semver_parse_version (semver.c:175-213). At most four slices are examined;
  // anything past the fourth is never reached, so it cannot invalidate the string.
  const slices = head.split('.').slice(0, 4);
  for (const slice of slices) {
    if (slice.length > SLICE_SIZE) return false;
    // `strtol` must consume the slice entirely: `if (endptr != next && *endptr != '\0')
    // return -1`. It accepts leading whitespace, an optional sign and digits — and
    // `has_valid_chars` above has already excluded whitespace, so what is left is an
    // optional `-`/`+` (both already cut as delimiters) followed by digits. An empty
    // slice leaves `endptr` on the terminator and passes, which is why `".."` reaches
    // the component count rather than failing here.
    if (slice !== '' && !/^[0-9]+$/.test(slice)) return false;
  }
  return slices.length >= 2 && slices.length <= 4;
}

/**
 * The `version` a preset file declares, as the loader would see it.
 *
 * Non-string values are not coerced: `load_from_json` does
 * `key_values.emplace(BBL_JSON_KEY_VERSION, it.value())` into a
 * `std::map<std::string, std::string>`, so a JSON number there is not a string the
 * parser can take. Treating it as absent is the same outcome — the preset does not
 * load either way — and is the honest reading of what we can tell.
 */
export function declaredVersion(raw: Record<string, unknown>): string {
  const v = raw.version;
  return typeof v === 'string' ? v : '';
}

/** Does this user preset's `version` let the slicer load it at all? */
export function versionLoads(raw: Record<string, unknown>): boolean {
  return parsesAsSemver(declaredVersion(raw));
}

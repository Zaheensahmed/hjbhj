# Job Autofill

A Manifest V3 Chrome extension that fills job application forms from a local
profile. Vanilla JS, no build step, no network requests.

**It never submits anything.** `content/fill.js` writes `.value` and `.checked`
on inputs, selects and textareas and dispatches `input` and `change`. It
contains no `.submit()`, no `.requestSubmit()` and no `.click()`, and
`test/smoke.mjs` greps the source (comments stripped) to keep that true.

## Install

1. `chrome://extensions`, turn on Developer mode
2. Load unpacked, pick this folder
3. Click the toolbar button on an application page

## Permissions

```
activeTab, scripting, storage
```

No `host_permissions`. No `content_scripts` block in the manifest, which is the
real guarantee that nothing runs on page load: there is no registered script to
run. Code reaches a page only when the popup injects it, and `activeTab` only
grants access because you clicked the toolbar button.

Everything lives in `chrome.storage.local`. No fetch to anything but the
extension's own bundled `data/profile.json`.

## Layout

```
manifest.json
background.js              seeds data/profile.json into storage on install
data/profile.json          your canonical application data
rules/                     EDITABLE. no engine logic lives here.
  field-rules.js           label pattern -> profile path or resolver
  role-rules.js            role-type keywords, requirement terms, GRC tokens
  eligibility-rules.js     eligibility_filters prose -> detectors
  synonyms.js              yes/no, states, visa phrasings, decline variants
  stopwords.js             label normalization noise
engine/                    PURE. no DOM, no chrome.*. node can import all of it.
  matcher.js               field descriptors + rules -> fill plan
  assembler.js             claim and skill selection
  verify.js                the enforcement layer
  eligibility.js           posting -> blockers and flags
  posting.js               JD text -> role type, term, pay range, requirements
  normalize.js             label and option normalization
content/
  label.js                 label resolution cascade
  scan.js                  DOM -> plain JSON descriptors
  fill.js                  applies the plan, outlines fields
  highlight.css            reference copy of the outline styles
shared/store.js            chrome.storage.local wrapper
popup/                     the orchestrator and UI
test/
  smoke.mjs                node test/smoke.mjs
  run.html                 the same pipeline against DOM fixtures
  fixtures/                Greenhouse-style and Lever-style markup
```

The engine never touches the DOM or `chrome.*`. That is what lets
`node test/smoke.mjs` run the matcher, assembler, verifier and eligibility
checker with no tooling, and it means the assembler cannot read page text it
was not handed.

## Matching

Labels resolve through a cascade, and the strategy that fires sets the
confidence weight:

| weight | strategy |
|--------|----------|
| 1.00 | `autocomplete` attribute |
| 0.95 | `aria-labelledby`, `aria-label`, `label[for]` |
| 0.90 | ancestor `<label>`, `fieldset > legend` |
| 0.80 | Greenhouse / Lever container |
| 0.70 | preceding text node or sibling block |
| 0.60 | `placeholder` |
| 0.45 | `name` or `id`, de-camelCased |

Every rule is scored, not first-match-wins. `score = rule.base x labelWeight`.

| tier | score | behaviour |
|------|-------|-----------|
| confident | >= 0.75 | filled, green outline |
| review | >= 0.45 | filled, blue outline, listed to verify |
| unknown | < 0.45 | left alone, amber outline, listed with an answer box |

Three tiers rather than two because a match off a `name` attribute is not the
same evidence as `autocomplete="email"` and should not wear the same green.

For selects and radio groups a desired value is matched against the real
options: exact, then prefix, then contains, then the synonym table. **If nothing
clears the bar the field becomes unknown rather than taking the nearest
option.** Picking "Other" because "A citizen of the U.S." was missing is the
failure mode this design exists to avoid.

### Things the matcher deliberately refuses

| field | behaviour |
|-------|-----------|
| Selective Service | never filled. `selective_service_registered` is marked UNCONFIRMED in the profile, so it is surfaced with that warning instead of answered. |
| College GPA | never filled. There is no college GPA yet. |
| Unqualified "GPA" | handed back with both high school numbers and the `gpa_rule`, since the form's intent is ambiguous. |
| Field of study | any option matching `/cyber/i` is vetoed per `field_of_study_NEVER_SELECT`. If nothing else matches the field goes unknown and names the vetoed option. |
| EEO questions | never filled. Listed under "your call" with the decline-to-self-identify option on that form located for you. |
| Consent and agreement checkboxes | never ticked. Ticking a box you have not read is not autofill. |
| Essay and cover-letter fields | never filled. The assembler only selects existing claims, so it cannot draft prose. Assembled material is shown as reference. |
| File inputs | cannot be filled by script at all. Listed first, in red, as **upload manually**. |
| Full calendar dates | the profile has May 2029 with no day. Asking for one is handed back rather than invented. |

### Learned answers

Answer an unknown in the popup and the label-to-answer mapping is saved to
`chrome.storage.local`. Lookup order: exact normalized label on the same host,
then exact label on any host, then a derived pattern with years, money and bare
numbers wildcarded. A learned answer scores 0.92, so it beats a generic regex
rule but loses to `autocomplete`. When a rule and a learned answer disagree the
popup shows both.

Nothing typed into a password or file field is stored, and values shaped like an
SSN or a card number are refused rather than written to disk.

## Standalone assembler

The popup has two tabs. **Paste a posting** takes a job description, runs the
engine over it and reports, with a copy button per section:

- eligibility, each finding quoting the sentence it matched plus the
  counter-argument from your profile
- inferred role type with every score, the keywords that matched, and a manual
  override
- resume bullets per entry with their claim IDs
- the filtered skills list, comma-separated
- gaps
- merge candidates

This path imports `engine/` and reads the textarea. Nothing else. It never calls
`chrome.scripting`, never reads a page, and the test suite greps `engine/`,
`engine/report.js`, `popup/tab-paste.js` and `cli.mjs` to keep that true, so it
keeps working when anything to do with page scanning breaks.

The same report on the command line:

```bash
node cli.mjs path/to/jd.txt
node cli.mjs path/to/jd.txt --role "AI / LLM security"
node cli.mjs path/to/jd.txt --skills 15
cat jd.txt | node cli.mjs -
node cli.mjs --help          # lists the role types
```

Exit code 0 is viable, 2 means a hard blocker or a refused output, 1 is a usage
error. The suite asserts the CLI output is byte-identical to what the popup
renders.

## Application tracker

`tracker/` is a separate tool: one page, no server, no build. `tracker/data.json`
is the source of truth and is meant to be edited by hand. Dates are
`YYYY-MM-DD`; anything else is reported as a bad date rather than guessed.

Views: all by status, not checked in 30+ days, upcoming deadlines, and needs
filling in.

Opening it:

| how | works |
|-----|-------|
| `chrome-extension://<id>/tracker/index.html` | yes, and reads the extension's storage overlay |
| `node test/serve.mjs` then `localhost:8731/tracker/index.html` | yes |
| straight from the filesystem | the page loads, then asks you to pick `data.json` with a file button, because a `file://` page may not read a file next to it |

The page cannot write to your disk. Edits are in memory, and **Copy as JSON** or
**Download data.json** hands you the file to replace by hand.

Seeded with 18 applications and the 6 deadlines from `key_deadlines`. Nine
statuses were inferred from the groupings in your notes rather than stated, so
they carry a `status_assumed` flag, show an **assumed** tag, and are listed
together under "Needs filling in". Fields nobody told me, such as portal URLs
and which account email was used, are blank rather than filled with a plausible
guess, and the same view lists them.

`tracker/logic.js` holds all the date arithmetic and view logic. It has no
import and no export, which is what lets it load as a classic script for the
`file://` case and as a node import for the tests.

## The assembler

Claims and skills are pools of individually true statements, each tagged. The
assembler infers the posting's role type, maps it to tags through
`assembly_rules.role_type_tags`, scores every claim on tag overlap weighted by
tag position, adds a small bonus when a claim already names something the
posting asks for, and takes the top 3 per entry.

Entry order comes from aggregate match score, not recency, per
`assembly_rules.lead_with`. The popup names which entry led and why.

### How "never invent a claim" is enforced

Not by intention. By construction:

1. **Selection works on claim IDs** (`gmu_drone.3`), never on strings. Text is
   resolved only at the final step by lookup in the allowed set built from the
   profile. There is no template literal, concatenation or `.replace()` applied
   to claim text anywhere in `engine/assembler.js`.
2. **Every output passes `engine/verify.js`** before it reaches the popup or a
   field. Each string must be identity-equal to a claim you wrote, or an
   approved two-claim join. A violation refuses to fill and shows the offending
   string.
3. **`NEVER_CLAIM` is filtered twice** for skills: before selection and again on
   final output, so a claim whose body mentions a banned term is caught too.

`test/smoke.mjs` feeds the verifier an invented claim, a softened qualifier, a
silent merge, strengthened wording and a `NEVER_CLAIM` term, and asserts all
five are rejected.

### Merging

`assembly_rules.resume_bullets` permits merging two claims "ONLY when both are
true as written and the merge adds no new assertion." No program can evaluate
that, so **the assembler never merges on its own.** It emits merge candidates
for you to approve into `assembly_rules.merge_pairs`, which ships empty. Once a
pair is listed there, the merge is the two claim texts joined by a separator
from a one-item whitelist (`". "`) and nothing else. The same join is rejected
by the verifier when the pair is not listed.

The separator whitelist is also what satisfies `writing_rules`: no em-dashes, and
no colons, semicolons or dashes introduced into role sections. Hyphens inside
your own compound words are yours and are left alone. An em-dash found in source
text is reported as a profile warning, not silently edited.

### NEVER_CLAIM scope

`NEVER_CLAIM` applies to **skills output and assembled claim text only**.

`projects[].stack` is **exempt**. The Receipts stack string names Swift, and
Swift is in `NEVER_CLAIM`, but the string is a true description of a
three-person project. `my_scope` already records that the Swift UI was not
yours, and it travels with the project in the assembler's output so that split
stays visible. The verifier never sees `stack`, because project metadata is not
a claim.

### GRC roles

`assembly_rules.no_grc_experience` says there is none. For a GRC-flavoured
posting the assembler uses the GRC tag list, shows that rule as a standing
warning in the popup, and runs a second check that rejects any output containing
a framework or audit token (`nist`, `iso 27001`, `soc 2`, `audit`,
`risk register`, `policy writing`, and the rest of
`GRC_IMPLICATION_TOKENS`) unless the token appears verbatim in a real claim.
None do.

### Gaps

Requirements the posting names that match nothing in the pools are reported as
gaps, not stretched into claims. For an offensive posting mentioning Ghidra and
AWS the popup says "asked for, not claimed: ghidra, aws".

## Eligibility

Runs before anything is assembled. A hard blocker stops assembly entirely and
the popup shows a red banner with an **Assemble anyway** override.

Every finding quotes the sentence it matched, verbatim, so you are judging the
posting rather than a regex. Detectors marked low confidence say so.

| detector | kind |
|----------|------|
| graduation window excluding May 2029 | hard |
| active clearance required at application | hard. "ability to obtain" is explicitly **not** a blocker, since `clearance_eligible` is yes |
| institution restriction | hard, low confidence |
| school-year on-site away from your campus | hard, low confidence |
| rising junior or senior preferred | soft, with the credit-standing counter-argument |
| penultimate or final year | soft, qualifies |
| less than N years to graduation | soft, borderline |
| minimum GPA stated | soft |
| N years professional experience | soft |

## Scope

Greenhouse, Lever and simple career sites. **Workday is detected and refused**
rather than half-filled: its dropdowns are custom React components, not real
selects, and need click simulation. That is a separate pass.

React and Vue controlled inputs are handled by writing through the prototype's
native `value` setter so the framework sees a real edit.

## Tests

```bash
node test/smoke.mjs
```

109 assertions covering the hard constraints, the refusals, the three tiers,
option vetoes, eligibility detectors, learned answers, and the manifest's
permission set.

### The DOM half

Two pages cover `content/label.js`, `content/scan.js` and `content/fill.js`,
which node cannot import because they need a real DOM.

`test/dom-check.html` opens straight from the filesystem, no server and no
module imports. It asserts label resolution across every strategy, what the
scanner collects and skips, that filling fires both `input` and `change`, that
outlines land and clear, and that **no submit event ever fires**. Open it in a
browser; the tab title reports the result.

`test/run.html` runs the whole pipeline, engine included, against the
Greenhouse-style and Lever-style fixtures and prints a report beside the filled
form. It needs an http origin because Chrome blocks ES module imports over
`file://`, so either:

```bash
node test/serve.mjs      # then open http://localhost:8731/test/run.html
```

or load the extension unpacked and open
`chrome-extension://<your-extension-id>/test/run.html`.

**Both DOM pages are unrun.** They were written but never executed, because the
environment they were built in had no browser that would execute a local file
and no DOM implementation for node. `node test/smoke.mjs` passes 109
assertions; everything in `content/` is verified only by reading it. Run
`test/dom-check.html` first.

## Editing

Rules live in `rules/`. When a form stumps the extension, add a rule to
`rules/field-rules.js` rather than touching `engine/`. A rule is a label pattern
plus a way to produce a value; the resolver contract is documented at the top of
that file.

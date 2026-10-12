# Testing, cold start

Do these in order. Each step says what to run, what working looks like, and what
to do when it does not.

Steps 1 to 3 need nothing but a terminal and a browser. Steps 4 onward need the
extension loaded. **Steps 7 to 10 are the ones most likely to need fixing**,
because they are the parts that have never met a real page.

Budget about an hour for all ten. Stop wherever you like; later steps do not
depend on earlier ones except where it says so.

---

## What is already verified, and what is not

| area | state |
|------|-------|
| `engine/` (assembler, verifier, eligibility, matcher, posting, report, triage, harvest parser, queue) | 574 assertions in node, all passing |
| `rules/` and `tracker/logic.js` | covered by the same suite |
| `cli.mjs` | run end to end by the suite, output compared byte for byte against the module |
| seed tracker data | validated by the suite |
| `content/*.js` (label, scan, fill, jobright-scan, jobright-harvest) | **never executed.** Verified by reading and by source greps only |
| `popup/*` | **never executed.** Element ids are checked against the markup, nothing more |
| `tracker/index.html` | **never executed** |
| Jobright extraction patterns | **never met a live page.** Expect to correct them |

Everything in the "never executed" rows was written without a browser that would
run it. That is the honest position, and steps 3 to 10 exist to close it.

---

## 0. Put your data back in place (1 minute)

Your real `data/profile.json` and `tracker/data.json` are gitignored, so a fresh
clone has only the redacted examples.

```bash
cd ~/Documents/GitHub/job-autofill && cp -n data/profile.example.json data/profile.json && cp -n tracker/data.example.json tracker/data.json
```

On the machine you built this on, both real files are already there and `cp -n`
will not touch them. **Working:** `node test/smoke.mjs` ends `686 passed`. On
example data it ends `650 passed, 0 failed, 2 skipped` and prints a note saying
which file it used.

If you ever see "Running on data/profile.example.json" in the popup, stop before
filling a real form: it will put "Your Name" into it.

## 1. The test suite (2 minutes)

```bash
cd ~/Documents/GitHub/job-autofill && node test/smoke.mjs
```

**Working:** last line reads `686 passed, 0 failed`. Two lines of CLI error text
appear partway through; those are deliberate, from the tests that check the CLI
fails cleanly.

**If it fails:** the failing line names the assertion and prints the actual
value. Nothing else in this list is worth doing until this is green, because
every other step rests on it. If a failure looks like a test being wrong rather
than the code, say so rather than editing the assertion to match.

---

## 2. The CLI (3 minutes)

```bash
cd ~/Documents/GitHub/job-autofill && node cli.mjs --help
```

Then paste a real posting into a file and run it:

```bash
node cli.mjs ~/Desktop/jd.txt
```

**Working:** six sections, Eligibility through Merge candidates. The role type
has a score and the keywords that earned it. Bullets carry claim IDs like
`gmu_drone.6`. Gaps lists what the posting wanted that you cannot claim.

**Check these three things specifically:**

- every bullet is text you wrote, word for word, with nothing merged or softened
- the eligibility quotes are single sentences from the posting, not run-ons
- nothing in `NEVER_CLAIM` appears in the skills line

**If a bullet looks wrong:** that is the important failure. The verifier should
make it impossible, so a bad bullet means the verifier has a hole. Capture the
exact output.

**If the role type is wrong:** `node cli.mjs jd.txt --role "<type>"` to override,
then adjust the keyword weights in `rules/role-rules.js`.

---

## 3. The DOM check page (5 minutes)

This is the first time `content/label.js`, `content/scan.js` and
`content/fill.js` will ever have run.

```bash
open ~/Documents/GitHub/job-autofill/test/dom-check.html
```

**Working:** the tab title reads `DOM check: N passed`. The right pane is a list
of green `ok` lines ending in `N passed, 0 failed`. The left pane shows a form
with green, blue, amber and red outlines on different fields.

**The four assertions that matter most** are at the bottom, under "The whole
point": the form was never submitted, the submit button was never clicked,
nothing changed its state, and the consent checkbox was not ticked.

**If something fails:** the failing line names the strategy and what it actually
got, for example `label-ancestor: Street Address` when `label-for` was expected.
Label resolution lives in `content/label.js`, the cascade is a single ordered
array in `resolveLabel()`, and the weights that go with it are at the top of the
file.

**If the page is blank:** the three content scripts load as classic `<script
src>` tags with relative paths. Opening the file from somewhere other than
`test/` breaks those paths.

---

## 4. Load the extension (3 minutes)

1. `chrome://extensions`, Developer mode on
2. Load unpacked, choose `~/Documents/GitHub/job-autofill`
3. Pin the toolbar button

**Working:** it loads with no errors, the icon is a blue square with three bars,
and the permissions shown are exactly activeTab, scripting, storage,
notifications. No host permissions, no site access.

**If the service worker shows an error:** click "service worker" to open its
console. It imports `engine/` as ES modules, so a syntax error anywhere in that
chain surfaces here.

While you are on this page, note the extension ID. Step 5 needs it.

---

## 5. The tracker (5 minutes)

Open `chrome-extension://<your-id>/tracker/index.html`.

**Working:** a header line reading something like "18 applications, 6 deadlines.
N not checked in 30+ days. 0 deadlines past." and four view buttons.

Go through all four:

- **All by status** — your 18 applications grouped. the first row under Under Review with its applied date.
- **Not checked in 30+ days** — the oldest unchecked row, with its day count. Nothing
  with status To apply.
- **Upcoming deadlines** — NREIP first at 2026-11-30, then NREIP references,
  then CIA Stokes. The three approximate ones say so.
- **Needs filling in** — an amber banner naming **nine companies whose status I
  inferred rather than you stating it**. Correct those first; everything else
  reads off them.

Then edit a cell, click **Copy the whole file as JSON**, and paste it over
`tracker/data.json`. The page cannot write to your disk and says so.

**If it shows "Could not read data.json":** you opened it from the filesystem
rather than the extension origin. Use the file picker in the banner, or the
extension URL above.

---

## 6. The paste tab (3 minutes)

Click the toolbar button anywhere, go to **Paste a posting**, paste a real
posting, press Run.

**Working:** the same six sections as the CLI, with a Copy button on each.
Changing the role-type dropdown re-runs it and changes which entry leads.

**This tab touches no page and calls no scripting API.** If every later step
fails, this one and the CLI still work, which is why they were built first.

---

## 7. A real application form (10 minutes)

Find a live Greenhouse or Lever posting. A real one, with a form you are
genuinely willing to leave half-filled.

Click the toolbar button. It scans and fills on open.

**Working:**

- green outlines on name, email, phone, address fields
- blue outlines on anything matched from a weaker signal, listed under "Verify
  these"
- amber outlines on fields it could not match, listed with an answer box
- **the resume and cover letter inputs outlined in thick red**, listed first
  under "Upload manually"
- nothing submitted, no button touched

**Check the refusals are actually refusing.** If the form has any of these, they
must be left alone and listed under "Your call":

- Selective Service, with the UNCONFIRMED warning from your profile
- a GPA field, handed back rather than answered
- gender, race, veteran or disability questions, with the decline option named
- an "I certify" checkbox, unticked

**If a field is filled wrong:** the row names the rule that did it. Fix the rule
in `rules/field-rules.js`, reload the extension, reopen the popup.

**If a field is unmatched that should match:** type the answer in its box and
press Save. It is remembered against that question and fills next time. If the
same question keeps coming back, add a pattern to `rules/field-rules.js` instead.

**If it filled a dropdown with the wrong option:** that is worse than leaving it
blank, and the matcher is supposed to prefer blank. Capture the field label and
the option list.

---

## 8. Jobright, stage 1 (15 minutes)

**This is the step most likely to need work.** The extraction patterns have
never seen the real markup.

Open a Jobright board, scroll so a good number of cards have rendered, click the
toolbar button.

**Working:** the popup opens on the **Triage** tab and shows a ranked table.
Each row has a verdict, the fields it read, and a bulleted list of reasons.

**Working even when extraction is imperfect:** the status line reports how many
cards it found, the banner says whether a known selector or the fallback text
heuristic found them, and every row names the fields it could not read.

**What to verify on the data:**

- winter and spring start terms come out SKIP with the enrollment-conflict reason
- a summer onsite role far from Baltimore does **not** skip
- a Security Clearance tag shows as an amber FLAG, not a skip
- a U.S. Citizen Only tag shows as a green BOOST
- alumni counts show as a green referral lead
- **no row anywhere says APPLY.** The ceiling is REVIEW

**If it finds zero cards:** the banner reports the page's text length, so you can
tell "did not load" from "loaded but nothing matched". Scroll and rescan first.
If it still finds nothing, the selectors need correcting.

**If it finds cards but fields are empty:** this is the expected failure, and
there is a loop for it. Click **Raw text** on a row, paste what you get, and the
pattern for that field goes in `rules/jobright-rules.js` under `FIELD_PATTERNS`.
Reload the extension and rescan. Nothing in `engine/` needs touching.

**If the banner says the text heuristic found the cards:** extraction will work
but miss more. Worth adding the real container selector to `CARD_SELECTORS`.

Before moving on, tick two or three cards to shortlist them. Step 10 needs them.

---

## 9. Jobright, stage 2 harvest (20 minutes)

Only once stage 1 reads cards properly. Harvesting against broken extraction
wastes twenty minutes and teaches you nothing.

On a scanned board, click **Harvest details**. Start with "shortlisted only"
ticked so the first run is three cards, not forty.

**Working:**

- the status line counts up, and **the toolbar badge shows `12/40`** live
- you can close the popup and switch tabs, and it keeps going. That is the whole
  point of the loop living in the page
- each card opens, pauses, closes, and there is a visible 3 to 6 second gap
- when it finishes, a desktop notification: **Jobright triage done**, with "N
  reviewed. X worth applying to, Y skipped, Z failed to harvest."
- clicking the notification focuses the Jobright tab
- reopening the popup clears the badge and each harvested row now shows the
  three sub-scores, the referral names, the blockers found in the real Required
  text, and the destination URL

**Watch for, and these are failures worth stopping over:**

- **anything clicking Apply, Easy Apply, Apply Now, Save or Dismiss.** It should
  be impossible: there is one `.click()` in the file and it refuses those
  labels. If you see it happen, stop the run and tell me
- a "Did you apply?" prompt being answered. Same
- the panel not closing, leaving panels stacked

**If a card times out:** it is marked "harvest failed" and the run continues.
The badge turns amber. This is designed behaviour, not a crash.

**If five fail in a row:** the run stops itself and says the page has probably
changed. Correct `PANEL_EVIDENCE` or `CLOSE_SELECTORS` in
`rules/jobright-rules.js`.

**Test the Stop button.** Start a run, close the popup, reopen it, press Stop.
It should finish the current card, keep everything read so far, and fire a
**Jobright triage stopped** notification saying how far it got.

**Test navigating away mid-run.** Everything harvested up to that point should
still be there when you come back.

**If the tab was in the background and cards failed:** check whether they failed
or were just slow. The loop multiplies its budget while hidden and reports
`throttled`. If genuinely-slow cards are being failed, raise `renderTimeoutMs`
or `hiddenMultiplier` in `rules/jobright-rules.js`.

---

## 10. Queue and notifications (10 minutes)

Go to the **Queue** tab. Your shortlisted cards from step 8 are there.

**Working:**

- **Open next** opens one destination in a foreground tab and marks it
  **opened**, never submitted
- set one to **submitted** yourself. A blue banner appears saying a record was
  written to the tracker, with its id and date, and noting the account email is
  blank
- **only then** does "Mark applied on Jobright" appear, below a line saying it
  will not answer that prompt
- click it: the Jobright tab focuses and the card is outlined. **Nothing is
  clicked.** You mark it applied yourself

**Then confirm the record landed.** Open the tracker again. The new record shows
with an `ext` tag. Copy the JSON and fold it into `tracker/data.json`.

**If "Mark applied on Jobright" says it cannot focus the board:** it needs the
Jobright tab from this browser session. Harvest and queue in one sitting.

---

## The one deviation you should decide on

The brief asked for a "mark applied on Jobright" action. It also said never
auto-answer "Did you apply?". I built the narrow reading: the action brings the
card into view and stops, and the prompt's wording is in `FORBIDDEN_CLICK` so no
code path can click it.

If you want it to actually click, that is a deliberate change in two places and
it weakens the guarantee that nothing in this codebase can create a false
applied-record. Your call, not mine to make quietly.

---

## When something is broken and you want it fixed

Most useful, in order:

1. the failing assertion line from `node test/smoke.mjs`
2. for a form field: the label text, the rule name shown in the row, and what it
   filled
3. for a Jobright card: the **Raw text** dump from that row
4. for the harvest loop: the status line and the service worker console
5. for anything in the popup: the popup's own console, via right-click, Inspect

The fix is almost always in `rules/`. `engine/` holds logic that is tested;
`rules/` holds the patterns that meet the real world, and those are the ones
written blind.

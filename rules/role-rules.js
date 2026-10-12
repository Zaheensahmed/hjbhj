// rules/role-rules.js -- EDITABLE
// Keyword weights used to infer a posting's role type. The keys here must stay
// in sync with assembly_rules.role_type_tags in the profile; the engine reads
// the tag lists from the profile, never from this file.

export const ROLE_KEYWORDS = {
  "offensive / red team / RE / vuln research": [
    [/\bred team(ing)?\b/g, 6], [/\boffensive security\b/g, 6],
    [/\bpenetration test(ing|er)?\b/g, 6], [/\bpentest(ing|er)?\b/g, 6],
    [/\bvulnerability research\b/g, 6], [/\bexploit (development|dev)\b/g, 5],
    [/\breverse engineer(ing)?\b/g, 5], [/\bbinary analysis\b/g, 4],
    [/\badversary emulation\b/g, 5], [/\bfuzz(ing|er)?\b/g, 3],
    [/\bvulnerability assessment\b/g, 4], [/\bbug bounty\b/g, 3],
    [/\bapplication security\b/g, 3], [/\bappsec\b/g, 3], [/\bweb app(lication)? pentest/g, 4]
  ],
  "blue team / SOC / detection / monitoring": [
    [/\bblue team\b/g, 6], [/\bsoc\b/g, 5], [/\bsecurity operations\b/g, 5],
    [/\bdetection engineer(ing)?\b/g, 6], [/\bthreat detection\b/g, 5],
    [/\bmonitoring\b/g, 3], [/\btriage\b/g, 3], [/\balert(s|ing)?\b/g, 3],
    [/\bincident response\b/g, 4], [/\bhunt(ing)?\b/g, 3],
    [/\bnetwork security\b/g, 3], [/\bpacket (capture|analysis)\b/g, 3],
    [/\bbaselin(e|ing)\b/g, 3], [/\bhardening\b/g, 3]
  ],
  "AI / LLM security": [
    [/\b(ai|a\.i\.) security\b/g, 6], [/\bllm\b/g, 6], [/\blarge language model/g, 6],
    [/\bprompt injection\b/g, 7], [/\bai safety\b/g, 6], [/\bml security\b/g, 5],
    [/\bmodel (safety|security|alignment)\b/g, 5], [/\bgenerative ai\b/g, 4],
    [/\bdata privacy\b/g, 3], [/\bpii\b/g, 3], [/\bred team(ing)? (models|ai|llms)\b/g, 6],
    [/\btrust (and|&) safety\b/g, 4]
  ],
  "embedded / hardware / systems": [
    [/\bembedded\b/g, 6], [/\bfirmware\b/g, 6], [/\bhardware security\b/g, 5],
    [/\brtos\b/g, 4], [/\bbare ?metal\b/g, 4], [/\bdevice driver\b/g, 5],
    [/\bmicrocontroller\b/g, 5], [/\bi2c\b/g, 3], [/\bspi\b/g, 3], [/\buart\b/g, 3],
    [/\bgpio\b/g, 3], [/\biot\b/g, 4], [/\bics\b/g, 4], [/\bscada\b/g, 4],
    [/\bot security\b/g, 4], [/\bsystems programming\b/g, 5], [/\braspberry pi\b/g, 3],
    [/\bkernel\b/g, 4], [/\bc\/c\+\+\b/g, 3]
  ],
  "public interest / federal / nonprofit": [
    [/\bfederal\b/g, 4], [/\bgovernment\b/g, 4], [/\bpublic (interest|sector|service)\b/g, 5],
    [/\bnonprofit\b/g, 5], [/\bnon-profit\b/g, 5], [/\bmission[- ]driven\b/g, 4],
    [/\bnational security\b/g, 4], [/\bdepartment of\b/g, 3], [/\bagency\b/g, 2],
    [/\bclearance\b/g, 3], [/\bcivil service\b/g, 4], [/\bngo\b/g, 4]
  ],
  "GRC / risk / audit / banking": [
    [/\bgrc\b/g, 7], [/\bgovernance\b/g, 5], [/\bcompliance\b/g, 5],
    [/\brisk (management|assessment|analyst)\b/g, 5], [/\baudit(or|ing)?\b/g, 5],
    [/\bnist\b/g, 4], [/\biso 270\d\d\b/g, 4], [/\bsoc 2\b/g, 4], [/\bcis (controls|benchmark)/g, 4],
    [/\bpci[- ]dss\b/g, 4], [/\bsox\b/g, 4], [/\bregulatory\b/g, 4],
    [/\bcontrol (testing|assessment)\b/g, 4], [/\bpolicy (writing|development)\b/g, 4],
    [/\bthird[- ]party risk\b/g, 4], [/\bbank(ing)?\b/g, 3], [/\bfinancial services\b/g, 3]
  ]
};

// Title text is a far stronger signal than body text.
export const TITLE_MULTIPLIER = 3;

// A second role type is reported alongside the first when it scores at least
// this fraction of the winner.
export const SECONDARY_THRESHOLD = 0.6;

// Below this absolute score nothing is confidently inferred and the popup asks
// you to pick instead of guessing.
export const MIN_CONFIDENT_SCORE = 6;

// Terms a posting can ask for that we have no claim or skill for. Surfaced as
// honest gaps rather than quietly dropped.
export const REQUIREMENT_TERMS = [
  "siem","splunk","sentinel","qradar","edr","crowdstrike","ghidra","ida pro",
  "malware analysis","digital forensics","threat intelligence","dlp","ids","ips",
  "aws","azure","gcp","cloud security","kubernetes","docker","terraform",
  "ansible","jenkins","ci/cd","react","node.js","go","rust","c++","kotlin",
  "swift","burp suite","metasploit","cobalt strike","nessus","qualys",
  "active directory","okta","saml","oauth","zero trust","soar","yara","sigma",
  "powershell","splunk spl","elastic","grafana","prometheus","nist 800-53",
  "iso 27001","soc 2","pci dss","hipaa","fedramp","risk register","policy writing"
];

// Tokens that would imply governance, risk, audit or framework experience.
// Rejected from assembled output unless they appear verbatim in a real claim.
export const GRC_IMPLICATION_TOKENS = [
  "nist","iso 27001","iso27001","soc 2","soc2","cis controls","cis benchmark",
  "pci dss","sox","fedramp","hipaa","gdpr","audit","auditor","audited",
  "risk register","risk assessment","policy writing","compliance program",
  "control framework","framework implementation","regulatory remediation",
  "gap assessment","attestation"
];

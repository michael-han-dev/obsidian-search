export const PARAPHRASE_NOTES: Readonly<Record<string, string>> = {
	"Daily/2026-09-02.md": `# 2026-09-02

## Morning

Leg day. Squats felt heavy, dropped the weight for the last set.

## Work

The vendor contract auto-renews on November 1 unless we send written notice thirty days before. Legal says an email to their account manager counts as written notice.

## Evening

Dinner with Sam at the Thai place on Fifth. Try the green curry next time.
`,
	"Daily/2026-09-19.md": `# 2026-09-19

## Errands

Picked up the dry cleaning and returned the library books.

## Car

The garage said the squeal is the brake pads worn down to the metal. Replacement booked for Friday, about 180 including labour.
`,
	"Inbox/Untitled 4.md": `# Untitled 4

The upstairs neighbour's washing machine leaks through our bathroom ceiling whenever they run a long cycle. The building manager said to photograph the stain and file it with the strata insurance, not ours.
`,
	"Meetings/Sync 14.md": `# Sync 14

## Attendees

Priya, Tom, Lena.

## Notes

Churn is concentrated in teams that never invited a second member during their first week. Onboarding should push the invite step earlier, before the first project is created.

## Action items

- Tom drafts the new onboarding flow.
- Lena pulls cohort numbers for August.
`,
	"Journal/Week 37.md": `# Week 37

I keep waking at 3am and lying there thinking about work until the alarm. Cutting coffee after lunch helped the last time this happened.

Also started the long novel Ana lent me.
`,
	"Projects/Atlas/Notes.md": `# Atlas

## Background

Atlas renders delivery routes on a map for the dispatch team.

## Risks

If the map tile provider raises prices again, the hosting bill would double, and we have no second provider under contract.

## Timeline

Pilot with two depots in October, everyone else in January.
`,
	"Projects/Beacon/Notes.md": `# Beacon

## Background

Beacon is the firmware for the warehouse shelf sensors.

## Risks

The firmware has no rollback. A bad update bricks devices in the field and someone has to drive out and reflash them by hand.
`,
	"Inbox/Clipping 2.md": `# Clipping 2

Spaced repetition: reviewing material at growing intervals beats rereading it all the night before an exam. Short daily sessions with self-quizzing work better than long highlighting sessions.
`,
	"Family/Notes for Mum.md": `# Notes for Mum

## Pills

The blue one with breakfast. The white one only if her ankles swell, and never on an empty stomach.

## Phone numbers

Dr Hale's office and the neighbour with the spare key are on the fridge.
`,
	"Gym/Cancel membership.md": "# Cancel membership\n\nThe gym needs a signed form in person to cancel. Bring the membership card.\n",
	"Work/Supplier list.md": "# Supplier list\n\nPaper and toner from Office Depot. Coffee beans from the roaster on Elm Street. Cleaning on Tuesdays.\n",
	"Home/Plumber quote.md": "# Plumber quote\n\nFixing the dripping kitchen tap: 95 call-out plus parts. They can come Thursday morning.\n",
	"Work/Customer interviews.md": "# Customer interviews\n\nFive customers liked the new pricing page and two asked for annual billing.\n",
	"Health/Sleep tracker setup.md": "# Sleep tracker setup\n\nTurn off battery optimisation for the tracker app or it stops recording at midnight. Pair the ring before charging it.\n",
	"Finance/Budget FY26.md": "# Budget FY26\n\nHosting 1,200 a month. Software licences 400. Travel 300.\n",
	"Learning/Exam schedule.md": "# Exam schedule\n\nStatistics exam on December 12 in room 204. Bring a calculator and photo ID.\n",
	"Health/Pharmacy.md": "# Pharmacy\n\nOpen until 9pm on weekdays. The refill line asks for the prescription number.\n",
	"Car/Insurance renewal.md": "# Insurance renewal\n\nThe car insurance renews in May. Ask about a discount for the dashcam.\n",
};

export type ParaphraseSearch =
	| { readonly kind: "paraphrase"; readonly query: string; readonly top: string; readonly passage: string; readonly distractor: string }
	| { readonly kind: "literal"; readonly query: string; readonly top: string; readonly passage: string; readonly absent: string }
	| { readonly kind: "no-match"; readonly query: string };

export const PARAPHRASE_SEARCHES: readonly ParaphraseSearch[] = [
	{ kind: "paraphrase", query: "deadline to cancel the supplier agreement before it rolls over", top: "Daily/2026-09-02.md", passage: "auto-renews on November 1", distractor: "Work/Supplier list.md" },
	{ kind: "paraphrase", query: "water coming through from the flat above, who pays for it", top: "Inbox/Untitled 4.md", passage: "leaks through our bathroom ceiling", distractor: "Home/Plumber quote.md" },
	{ kind: "paraphrase", query: "why do new customers stop using the product", top: "Meetings/Sync 14.md", passage: "Churn is concentrated", distractor: "Work/Customer interviews.md" },
	{ kind: "paraphrase", query: "trouble staying asleep through the night", top: "Journal/Week 37.md", passage: "waking at 3am", distractor: "Health/Sleep tracker setup.md" },
	{ kind: "paraphrase", query: "what could make our infrastructure costs blow up", top: "Projects/Atlas/Notes.md", passage: "hosting bill would double", distractor: "Finance/Budget FY26.md" },
	{ kind: "paraphrase", query: "best way to memorise things for a test", top: "Inbox/Clipping 2.md", passage: "Spaced repetition", distractor: "Learning/Exam schedule.md" },
	{ kind: "paraphrase", query: "which medicine she takes in the morning", top: "Family/Notes for Mum.md", passage: "The blue one with breakfast", distractor: "Health/Pharmacy.md" },
	{ kind: "paraphrase", query: "why does my vehicle screech when stopping", top: "Daily/2026-09-19.md", passage: "brake pads worn down", distractor: "Car/Insurance renewal.md" },
	{ kind: "literal", query: '"Beacon" what could go badly wrong', top: "Projects/Beacon/Notes.md", passage: "no rollback", absent: "Projects/Atlas/Notes.md" },
	{ kind: "no-match", query: "how do I repot an orchid" },
	{ kind: "no-match", query: "history of the Roman aqueducts" },
];

export const NO_MATCH_ELSEWHERE: Readonly<Record<"fixture" | "everyday", readonly string[]>> = {
	fixture: ["rules of cricket for beginners", "how volcanoes form", "choosing a wedding photographer"],
	everyday: ["photosynthesis in desert plants", "the plot of Moby Dick", "how to change a bicycle tyre"],
};

// Measured 2026-10-24 with the selected encoder, after the searches above were frozen.
export const KNOWN_MISSES: readonly string[] = ["why do new customers stop using the product"];

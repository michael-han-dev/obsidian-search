export const EVERYDAY_NOTES: Readonly<Record<string, string>> = {
	"Recipes/Weeknight pasta.md": "---\ntags: [recipe]\ncuisine: italian\n---\n# Weeknight pasta\n\nGarlic, olive oil, and cherry tomatoes thrown in while the pasta boils. Ready in about twenty minutes on a work night.\n",
	"Recipes/Slow cooker ribs.md": "---\ntags: [recipe]\ncuisine: american\n---\n# Slow cooker ribs\n\nRub the night before, start the pot on low in the morning, and by dinner the meat falls off the bone.\n",
	"Work/Standups/2026-10-12.md": "---\ntags: [work, meeting]\ntype: standup\n---\n# Standup 2026-10-12\n\nPayment webhook is unblocked. Maria is reviewing the invoice emails this week.\n",
	"Work/Standups/2026-10-16.md": "---\ntags: [work, meeting]\ntype: standup\n---\n# Standup 2026-10-16\n\nDecision: we postpone hiring until Q1 so the budget can settle. The release moves to the 30th.\n",
	"Work/Hiring plan.md": "---\ntags: [work]\nstatus: in progress\n---\n# Hiring plan\n\nTwo backend roles to open in Q1, waiting on headcount approval from finance.\n",
	"Work/Q4 planning.md": "---\ntags: [work, meeting]\n---\n# Q4 planning\n\nGoals for the quarter: launch the beta, cut the support load, run the pricing survey.\n",
	"Work/Archive/2025 retro.md": "---\ntags: [work, archive]\n---\n# 2025 retro\n\nWhat went well and what to change. Hiring was slow last year too.\n",
	"Personal/Doctor appointment.md": "---\ntags: [health]\n---\n# Doctor appointment\n\nAnnual checkup booked for November 3rd at 9:40. Bring the vaccine booklet and the bloodwork referral.\n",
	"Personal/Reading list.md": "---\ntags: [books]\n---\n# Reading list\n\nQueue for the next few months: a book about maps, the new Fermi biography, and something light for train rides.\n",
	"Personal/Japan trip.md": "---\ntags: [travel]\n---\n# Japan trip\n\nKyoto in April for the blossoms. To sort: rail pass order form, temple opening hours, and a packing list with adapters and walking shoes.\n",
	"Home/Mortgage renewal.md": "---\ntags: [home]\n---\n# Mortgage renewal\n\nThe fixed term ends in March. Compare the bank's offer against a broker before locking a rate.\n",
	"Learning/Guitar practice.md": "---\ntags: [learning]\n---\n# Guitar practice\n\nBarre chords still buzz. Ten slow minutes a day with the metronome beats one long session.\n",
	"Inbox/Scratch.md": "# Scratch\n\nHalf-formed ideas: a shelf for the hallway, and asking the landlord about the dripping tap.\n",
};

export interface EverydaySearch {
	readonly query: string;
	readonly kind: "results" | "matching";
	readonly top?: string;
	readonly files?: readonly string[];
	readonly absent?: readonly string[];
}

export const EVERYDAY_SEARCHES: readonly EverydaySearch[] = [
	{ query: "quick dinner ideas for a weeknight", kind: "results", top: "Recipes/Weeknight pasta.md" },
	{ query: "tag:recipe something to start in the morning", kind: "results", top: "Recipes/Slow cooker ribs.md" },
	{ query: "why did we postpone hiring", kind: "results", top: "Work/Standups/2026-10-16.md" },
	{ query: "tag:work -tag:archive hiring", kind: "results", top: "Work/Hiring plan.md", absent: ["Work/Archive/2025 retro.md"] },
	{ query: "path:Work meeting notes about the release", kind: "results", top: "Work/Standups/2026-10-16.md" },
	{ query: "tag:meeting goals for this quarter", kind: "results", top: "Work/Q4 planning.md" },
	{ query: 'property.status:"in progress"', kind: "matching", files: ["Work/Hiring plan.md"] },
	{ query: "file:appointment", kind: "matching", files: ["Personal/Doctor appointment.md"] },
	{ query: "when is my checkup and what should I bring", kind: "results", top: "Personal/Doctor appointment.md" },
	{ query: "books to read on the train", kind: "results", top: "Personal/Reading list.md" },
	{ query: "what to pack for Kyoto", kind: "results", top: "Personal/Japan trip.md" },
	{ query: "renew the mortgage with the bank or a broker", kind: "results", top: "Home/Mortgage renewal.md" },
	{ query: "guitar chords keep buzzing", kind: "results", top: "Learning/Guitar practice.md" },
	{ query: '"slow cooker"', kind: "matching", files: ["Recipes/Slow cooker ribs.md"] },
	{ query: "path:Work -path:Standups", kind: "matching", files: ["Work/Archive/2025 retro.md", "Work/Hiring plan.md", "Work/Q4 planning.md"] },
];

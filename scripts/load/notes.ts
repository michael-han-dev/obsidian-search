import { NOTES, noteText } from "../../test/fixtures/vault.ts";

export interface LoadNote {
	readonly path: string;
	readonly text: string;
}

interface Topic {
	readonly folder: string;
	readonly tags: readonly string[];
	readonly nouns: readonly string[];
	readonly headings: readonly string[];
	readonly sentences: readonly string[];
}

const TOPICS: readonly Topic[] = [
	{
		folder: "Kitchen",
		tags: ["cooking", "cooking/baking", "recipes"],
		nouns: ["Bread", "Soup", "Curry", "Pasta", "Salad", "Stew", "Pie", "Noodles"],
		headings: ["Ingredients", "Method", "Variations", "Storage", "Notes"],
		sentences: [
			"Toast the {x} in a dry pan until it smells nutty.",
			"Let the dough rest for {n} minutes before shaping it.",
			"A pinch of salt brings out the sweetness of the {x}.",
			"Simmer the broth gently so it stays clear.",
			"Leftovers keep for {n} days in a sealed container in the fridge.",
			"Swap the {x} for chickpeas to make it vegetarian.",
			"Taste and adjust the acidity with lemon juice at the end.",
			"The oven should be fully preheated before the tray goes in.",
		],
	},
	{
		folder: "Garden",
		tags: ["garden", "garden/vegetables", "outdoors"],
		nouns: ["Beans", "Roses", "Compost", "Herbs", "Squash", "Lettuce", "Apple tree", "Lawn"],
		headings: ["Planting", "Watering", "Pests", "Harvest", "Soil"],
		sentences: [
			"Water the {x} deeply twice a week instead of a little every day.",
			"Aphids gather under the leaves when the weather turns warm.",
			"Mulch keeps the soil moist and stops weeds from sprouting.",
			"Plant the seedlings {n} centimetres apart so air can move between them.",
			"Turn the compost pile every week to keep it from smelling.",
			"Pick the {x} in the morning when it is still cool.",
			"Yellow lower leaves often mean the plant needs more nitrogen.",
			"Frost can arrive as late as the middle of spring here.",
		],
	},
	{
		folder: "Engineering",
		tags: ["work", "work/engineering", "software"],
		nouns: ["Service", "Queue", "Deploy", "Index", "Cache", "Gateway", "Scheduler", "Worker"],
		headings: ["Design", "Failure modes", "Rollout", "Monitoring", "Open questions"],
		sentences: [
			"The {x} retries failed jobs with exponential backoff up to {n} times.",
			"Alerts fire when the error rate stays above one percent for five minutes.",
			"We roll out to ten percent of traffic before the full release.",
			"Every write carries a request ID so duplicates can be dropped.",
			"The {x} reads its settings from the environment at startup.",
			"Dashboards show latency at the 50th and 99th percentile.",
			"A feature flag lets us turn the new path off without a deploy.",
			"Load tests ran at {n} requests per second without errors.",
		],
	},
	{
		folder: "Money",
		tags: ["finance", "finance/budget", "personal"],
		nouns: ["Budget", "Savings", "Rent", "Insurance", "Pension", "Groceries", "Car loan", "Utilities"],
		headings: ["This month", "Plan", "Receipts", "Goals", "Review"],
		sentences: [
			"Set aside {n} percent of each paycheck before spending anything.",
			"The {x} payment is due on the first of the month.",
			"Compare quotes from three providers before renewing.",
			"Keep receipts for deductible expenses in one folder.",
			"An emergency fund should cover about six months of costs.",
			"Automatic transfers make saving happen without thinking about it.",
			"The {x} went up by {n} dollars this year.",
			"Review subscriptions each quarter and cancel the unused ones.",
		],
	},
	{
		folder: "Travel",
		tags: ["travel", "travel/plans", "personal"],
		nouns: ["Lisbon", "Kyoto", "Oslo", "Lima", "Hanoi", "Vienna", "Quebec", "Porto"],
		headings: ["Getting there", "Where to stay", "Food", "Day trips", "Packing"],
		sentences: [
			"The train from the airport to {x} takes about {n} minutes.",
			"Book the museum tickets online to skip the queue.",
			"The old town is easiest to explore on foot.",
			"Pack a light rain jacket because the weather changes quickly.",
			"Street food stalls near the market open after sunset.",
			"A day pass covers buses, trams, and the ferry.",
			"Most shops in {x} close early on Sundays.",
			"Learn a few greetings in the local language before arriving.",
		],
	},
	{
		folder: "Health",
		tags: ["health", "health/fitness", "habits"],
		nouns: ["Running", "Sleep", "Stretching", "Diet", "Cycling", "Swimming", "Posture", "Hydration"],
		headings: ["Routine", "Progress", "Problems", "Advice", "Log"],
		sentences: [
			"Warm up for {n} minutes before any hard effort.",
			"Going to bed at the same time each night improves sleep quality.",
			"Increase weekly distance by no more than ten percent.",
			"Sore knees after {x} can come from worn out shoes.",
			"Drink a glass of water first thing in the morning.",
			"Rest days matter as much as training days.",
			"Screens before bed make it harder to fall asleep.",
			"Track resting heart rate to notice overtraining early.",
		],
	},
	{
		folder: "Meetings",
		tags: ["work", "work/meetings", "notes"],
		nouns: ["Standup", "Planning", "Retro", "One on one", "Kickoff", "Review", "Sync", "Offsite"],
		headings: ["Attendees", "Agenda", "Decisions", "Action items", "Follow up"],
		sentences: [
			"We agreed to move the launch by {n} days.",
			"The team will pair on the migration next week.",
			"Ask design for updated mockups before Thursday.",
			"Hiring for the open role is paused until next quarter.",
			"The {x} ran long, so the last topic moved to email.",
			"Everyone should update their tickets before the demo.",
			"Customer feedback pointed to slow page loads on mobile.",
			"We need a clear owner for the on-call rotation.",
		],
	},
	{
		folder: "Reading",
		tags: ["reading", "reading/books", "ideas"],
		nouns: ["Novel", "Biography", "Essay", "History", "Poetry", "Memoir", "Science", "Philosophy"],
		headings: ["Summary", "Quotes", "Themes", "Opinion", "Related"],
		sentences: [
			"The author argues that habits shape identity more than goals do.",
			"Chapter {n} describes the early years in a small fishing town.",
			"The {x} is told from three alternating points of view.",
			"I underlined the passage about patience and attention.",
			"The ending felt rushed compared with the slow first half.",
			"Several ideas echo the stoic philosophers.",
			"It would pair well with a history of the same period.",
			"The prose is plain but the structure is clever.",
		],
	},
	{
		folder: "Home",
		tags: ["home", "home/repairs", "chores"],
		nouns: ["Kitchen sink", "Roof", "Heater", "Window", "Garage", "Bathroom", "Fence", "Attic"],
		headings: ["Problem", "Fix", "Parts", "Cost", "Next time"],
		sentences: [
			"The {x} started leaking after the cold snap.",
			"Turn off the water at the main valve before opening the pipes.",
			"Replacement parts cost about {n} dollars at the hardware store.",
			"Bleed the radiators at the start of every winter.",
			"Seal the gaps around the frame to stop drafts.",
			"Call a licensed electrician for anything behind the panel.",
			"Clean the gutters before the autumn storms.",
			"The {x} needs a second coat of paint next summer.",
		],
	},
	{
		folder: "Music",
		tags: ["music", "music/practice", "hobbies"],
		nouns: ["Guitar", "Piano", "Scales", "Chords", "Rhythm", "Ear training", "Song", "Metronome"],
		headings: ["Practice plan", "Pieces", "Technique", "Goals", "Recordings"],
		sentences: [
			"Practice slowly with a metronome at {n} beats per minute.",
			"Record yourself once a week to hear real progress.",
			"Learn the {x} part in small sections before joining them.",
			"Relax the wrist so fast passages do not cause pain.",
			"Short daily sessions beat one long weekend session.",
			"Transcribe a solo by ear to train listening.",
			"Change the strings when they sound dull.",
			"Play the piece for a friend to practice under pressure.",
		],
	},
];

const ADJECTIVES = ["Quick", "Weekly", "Winter", "Summer", "Simple", "Better", "Old", "New", "Shared", "Private", "Draft", "Final"];
const STATUSES = ["todo", "in progress", "done", "blocked"];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function loadNotes(count: number, seed = 1): LoadNote[] {
	const random = mulberry32(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
	const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
	const notes: LoadNote[] = NOTES.map((note) => ({ path: note.path, text: noteText(note) }));
	const titles: string[] = [];
	for (let i = 0; notes.length < count; i++) {
		const topic = TOPICS[i % TOPICS.length]!;
		const noun = pick(topic.nouns);
		const title = `${pick(ADJECTIVES)} ${noun.toLowerCase()} ${i + 1}`;
		const fill = (s: string) => s.replace("{x}", noun.toLowerCase()).replace("{n}", String(int(2, 90)));
		const front = [`tags: [${[pick(topic.tags), pick(topic.tags)].filter((t, k, a) => a.indexOf(t) === k).join(", ")}]`];
		if (random() < 0.6) front.push(`status: ${pick(STATUSES)}`);
		if (random() < 0.4) front.push(`priority: ${int(1, 3)}`);
		if (random() < 0.3) front.push(`reviewed: ${random() < 0.5}`);
		const body: string[] = [`# ${title}`];
		for (let s = int(1, 4); s > 0; s--) {
			body.push(`## ${pick(topic.headings)}`);
			for (let p = int(1, 3); p > 0; p--) {
				const sentences = Array.from({ length: int(2, 5) }, () => fill(pick(topic.sentences)));
				if (random() < 0.15) sentences.push(`#${pick(topic.tags)}`);
				if (titles.length > 0 && random() < 0.2) sentences.push(`See [[${pick(titles)}]].`);
				if (random() < 0.05) sentences.push(`^b${i}x${p}`);
				body.push(sentences.join(" "));
			}
		}
		titles.push(title);
		notes.push({ path: `${topic.folder}/${title}.md`, text: `---\n${front.join("\n")}\n---\n${body.join("\n\n")}\n` });
	}
	return notes;
}

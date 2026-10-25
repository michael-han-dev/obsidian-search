export const PROPERTY_NOTES: Readonly<Record<string, string>> = {
	"Props/Active plan.md": "---\nstatus: in progress\npriority: 2\nowners: [ada, 3]\n---\n# Active plan\n\nShip the importer before the draft deadline.\n",
	"Props/Quoted priority.md": '---\nstatus: In Progress\npriority: "2"\ndone: true\n---\n# Quoted priority\n\nThe drafts folder holds old ideas.\n',
	"Props/String true.md": '---\ndone: "true"\nempty:\n---\n# String true\n\nA draft-ready outline for C# and C++ notes.\n',
};

export const FILTER_NOTES: Readonly<Record<string, string>> = {
	"Filters/Engineering/API reliability.md": "---\ntags: [work, work/engineering]\n---\n# API reliability\n\n## Retries\n\nEvery request carries a cache-key header.\n",
	"Filters/Engineering/Cache notes.md": "---\naliases: [api]\ntags: [workshop]\n---\n# Cache notes\n\nA cache key is not the same as a cache-key. These two words matter.\n",
	"Filters/Projects/Work/Plan.md": "---\ntags: [team/work]\nstatus: in progress\npriority: 2\n---\n# Plan\n\nThis is a draft-ready plan.\n",
	"Filters/Projects/Workshop/Plan.md": '---\nstatus: In Progress\npriority: "2"\ndone: true\nowners: [ada, 3]\n---\n# Plan\n\nThe drafts folder holds old ideas.\n',
	"Filters/Archive/Old C++ notes.md": '---\ntags: [Work/Archive]\ndone: "true"\nempty:\nnested:\n  a: 1\nmixed: [a, {x: 1}]\n---\n# Old\n\nTemplates in C++ and C# differ.\n\nA draft.\n',
	"Filters/Inbox/Café résumé.md": '---\nowners: [grace]\n---\n# Café\n\nCrème brûlée at the café. DRAFT\n\nThey say "hi" \\ now.\n',
};

const F = {
	api: "Filters/Engineering/API reliability.md",
	cache: "Filters/Engineering/Cache notes.md",
	work: "Filters/Projects/Work/Plan.md",
	workshop: "Filters/Projects/Workshop/Plan.md",
	old: "Filters/Archive/Old C++ notes.md",
	cafe: "Filters/Inbox/Café résumé.md",
};

export const FILTER_CASES: Readonly<Record<string, readonly string[]>> = {
	'"cache-key"': [F.api, F.cache],
	'"cache key"': [F.cache],
	'"C++"': [F.old],
	'"c#"': [F.old],
	'"crème brûlée"': [F.cafe],
	'"retries"': [F.api],
	'"say \\"hi\\" \\\\ now"': [F.cafe],
	'-"two words"': [F.api, F.work, F.workshop, F.old, F.cafe],
	"-draft": [F.api, F.cache],
	"file:api": [F.api],
	"File:api": [F.api],
	"file:.md -file:plan": [F.api, F.cache, F.old, F.cafe],
	"file:cafe": [],
	"file:café": [F.cafe],
	'path:"Filters/Projects/Work"': [F.work, F.workshop],
	'path:"Filters/Projects/Work/"': [F.work],
	'path:"Filters\\Projects\\Work/"': [F.work],
	"tag:work": [F.api, F.old],
	"tag:#WORK/engineering": [F.api],
	"tag:work tag:work/archive": [F.old],
	"tag:team": [F.work],
	"-tag:work": [F.cache, F.work, F.workshop, F.cafe],
	'property.status:"in progress"': [F.work, F.workshop],
	"property.owners:ADA": [F.workshop],
	"property.Priority:2": [F.work],
	'property.priority:"2"': [F.workshop],
	"property.done:true": [F.workshop],
	'property.done:"true"': [F.old],
	"property.owners:ada": [F.workshop],
	"property.owners:3": [F.workshop],
	"property.mixed:a": [F.old],
	"property.empty:null": [],
	"property.missing:x": [],
	"-property.done:true": [F.api, F.cache, F.work, F.old, F.cafe],
};

export const PARSE_ERRORS: Readonly<Record<string, string>> = {
	'"unclosed quote': 'Close the quote after "unclosed quote.',
	'file:"API': 'Close the quote after "API.',
	"collection:docs": "Dowse searches this vault only for now, so collection: isn't available. Remove it.",
	"-collection:docs": "Dowse searches this vault only for now, so collection: isn't available. Remove it.",
	"content:retry": "content: is a native Search operator that Dowse doesn't support. Use Obsidian's Search for it.",
	"line:(a b)": "line: is a native Search operator that Dowse doesn't support. Use Obsidian's Search for it.",
	"foo:bar": "Unknown filter foo:. Dowse understands file:, path:, tag:, and property.NAME:. To search for this text, put it in quotes.",
	"tag:": "Add a value after tag:.",
	"tag:#": "Add a tag name after tag:#.",
	"property.:x": "Name the property, as in property.status:done.",
	"file:": "Add a value after file:.",
	'""': "Put text inside the quotes, or remove them.",
	"alpha OR beta": "Dowse combines everything with AND, so OR isn't supported. Run separate searches instead.",
	"(tag:work tag:home)": "Dowse doesn't group searches with parentheses. Remove them; all filters must match.",
	"[status:done]": "Write property filters as property.NAME:VALUE, not [status:done].",
	"/sour.*dough/": "/sour.*dough/ looks like a regular expression, which Dowse doesn't support. To match the text, quote it.",
	"path:/Projects/": 'path:/Projects/ is a regular expression in Obsidian\'s Search, which Dowse doesn\'t support. To match the text, quote it: path:"/Projects/".',
};

const ORDER_TEXT = "# T\n\nfirst\n\nsecond shared line\n";
export const ORDER_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
	["Order/Zeta.md", "Order/b/README.md", "Order/a/README.md", "Order/alpha.md", "Order/Émile.md", "Order/ｚ wide.md", "Order/\u{1f600} smile.md"].map((p) => [p, ORDER_TEXT]),
);
export const ORDER_FIRST_SIX = ["Order/alpha.md", "Order/a/README.md", "Order/b/README.md", "Order/Zeta.md", "Order/Émile.md", "Order/ｚ wide.md"];

export const TWIN_NOTES: Readonly<Record<string, string>> = {
	"Twins/a/Same.md": "# Same\n\nIdentical twin body text about lanterns.\n",
	"Twins/b/Same.md": "# Same\n\nIdentical twin body text about lanterns.\n",
};

export const LONG_LINE = "word ".repeat(300).trim();
export const SHAPE_NOTES: Readonly<Record<string, string>> = {
	"Shapes/Code and long.md": `# Shapes\n\nfirst paragraph\n\nsecond paragraph\n\n\`\`\`\nconst a = 1;\n\nconst b = 2;\n\`\`\`\n\nshort line\n${LONG_LINE}\n`,
};
export const SHAPE_FIRST_PASSAGE = "first paragraph\n\nsecond paragraph\n\n```\nconst a = 1;\n\nconst b = 2;\n```\n\nshort line";

export const SIBLING_NOTES: Readonly<Record<string, string>> = {
	"Quokka ledger.md": "# Quokka ledger\n\nThe quokka migration ledger lists every island crossing.\n",
	"Nested/Quokka routes.md": "---\ntags: [quokka]\n---\n# Quokka routes\n\nQuokka ferry routes and tide tables.\n",
};

export const NATIVE_TEXT_NOTES: Readonly<Record<string, string>> = {
	"Native/Body word.md": "A draft of the plan.\n",
	"Native/Body plural.md": "Old drafts live here.\n",
	"Native/Body upper.md": "DRAFT version.\n",
	"Native/Hyphen.md": "A draft-ready outline.\n",
	"Native/Front value.md": "---\nstatus: draft\n---\nNothing else here.\n",
	"Native/Front key.md": "---\ndraft: true\n---\nNothing else here.\n",
	"Native/Front alias.md": "---\naliases: [Draft memo]\n---\nNothing else here.\n",
	"Native/Draft in name.md": "Nothing else here.\n",
	"Native/Drafts/In folder.md": "Nothing else here.\n",
	"Native/Heading.md": "# Draft\n\nNothing else here.\n",
	"Native/Tag.md": "Tagged #draft here.\n",
	"Native/Code.md": "```\ndraft\n```\n",
	"Native/Comment.md": "Visible. %% draft %%\n",
	"Native/Link.md": "See [[Draft notes]].\n",
	"Native/Html.md": "<span>draft</span>\n",
	"Native/Url.md": "See https://example.com/draft\n",
	"Native/Clean.md": "Nothing to see.\n",
	"Native/Nfc.md": "Coffee caf\u00e9 here.\n",
	"Native/Nfd.md": "Coffee cafe\u0301 here.\n",
	"Native/Phrase.md": "The cache-key header.\n",
	"Native/Phrase space.md": "The cache key header.\n",
	"Native/Middle.md": "We redrafted it.\n",
	"Native/Underscore.md": "A draft_x item.\n",
	"Native/Digit.md": "Version draft2 here.\n",
	"Native/Accent.md": "Un draft\u00e9 mot.\n",
};

export const NATIVE_TEXT_QUERIES: readonly string[] = [
	"-draft",
	'"draft"',
	'-"draft"',
	'"DRAFT"',
	'"of the plan"',
	'"caf\u00e9"',
	'"cafe\u0301"',
	'"cache-key"',
	'"cache key"',
	'-"cache key"',
	"file:draft",
	"path:draft",
	"-file:draft",
	"file:caf\u00e9",
	"-raft",
	'"raft"',
	'"redraft"',
	'"in name"',
	'"name.md"',
	'"draft_x"',
	'"draft2"',
	'"t_x"',
];

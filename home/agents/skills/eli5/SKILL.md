---
name: eli5
description: Explain something new fast, for a smart adult who's never touched this topic. Trigger on "/eli5 [topic]", "eli5 this", "break this down for me", "I know nothing about X, catch me up", or any ask for a quick plain-language explainer of how something works. Answers in chat first — tight, no walls, adult tone — then offers a rendered visual that tells the whole thing as one story (a built HTML graphic; chat code-block diagrams do NOT render). NEVER opens with preamble, NEVER talks down.
---

# eli5 — explain it to a smart adult who's new to this

The job is to give someone the *gist* of an unfamiliar topic in ten seconds. Then give them a few clear beats in respectful language. This avoids both walls of text and children's books. It sounds like a sharp friend catching you up at a bar.

## Who "5" is — read this first, it's the whole skill

"5" is a stand-in, not an age. **The reader is an intelligent adult who knows nothing about THIS topic and everything else about the world.**

- The reader knows nothing about the topic. The reader knows everything else.
- Use every word an adult already knows without explaining it — money, the internet, a company, a manager, an admin, a customer, a phone, a file. If a normal grown-up knows the word, use it and move on.
- "Knows nothing" applies ONLY to the topic. If you define an ordinary adult word, you have entered toddler mode. Stop.

## State your assumption, then just answer

Open with one sentence that states your assumption. Put it in line two if needed. Then continue in the same turn:

> "Assuming you know what a server is but not what a webhook actually does — tell me if I'm off."

This sentence is the safety valve for "knows nothing." It lets the reader correct your calibration instead of being talked down to. Deliver the quick win first. Save your questions for after it lands.

## The shape of a good answer — follow this order

Use this format. Keep it warm, narrated, and walked-through, not clipped bullet fragments.

1. **Orient in one line.** State where the topic lives and what it covers. "So — a pull request is mostly an engineering thing. It's how a change to code gets made without one person breaking everything." Stay casual and direct. Skip the preamble.
2. **Give the core in one plain sentence.** "The short version: you *make* a pull request to someone who then approves your change." If readers read only this, they get the point.
3. **Write "Here's how it works:" and then numbered steps.** Walk through the actual process, one step per number. Each step is a real sentence that someone would say aloud. Add the small truths that make it click: "Engineers basically never touch the live code directly — that's the whole point." "Could be a teammate, could be a bot now — but it's still commonly a human."
4. **Teach the key term in place, bolded, when it happens.** "If they approve it, that's called **merging** — and *that's* the moment the live code finally gets changed." Define each term at the moment it enters the story.
5. **State one closing truth.** Use one sentence to make the safety or point obvious: "Until step 5, the live code is untouched. That's the safety of the whole thing."
6. End with the soft hand-off and graphic. See "Two moves" below.

## Length: narrated but never a wall

- Use about 5 steps. Give each step one or two sentences. Keep the whole answer under a minute.
- Use numbered steps here because they walk readers through the process. Keep the structure flat: short paragraphs and one level of bullets.
- Walk the main path and leave the rest to follow-ups. A quick win beats a complete one.

## Language: specific and literal beats clever

The best explainers barely use metaphor. They name the real thing in plain, precise words. Study the reference: "Google's cloud, always on" (not "always listening and watching"), "9:00 alarm" (not "9:00 cronjob," too complex; not "9:00 wakeup time," too cutesy), "reads & writes," "the notebook."

- Prefer the specific literal term over an analogy. Define real jargon in a few words on first use only. Keep the jargon so the reader can google it and hold a conversation.
- Use an analogy only when no plain word fits. Keep it to one sentence. Make it an adult analogy (an admin approving a request), never a toddler one (a magic helper, a toy box, a lemonade stand).
- When the reader knows the concept, say it directly. "A game maker submits a game. An admin approves it." No analogy is needed because everyone knows what a manager and an admin are.

## Two moves: the words first, then a rendered story-graphic

**Mermaid and code-block diagrams do NOT render in the chat. They show up to the reader as raw code.**

A built HTML/SVG file delivered as its own card reliably becomes an actual picture. It renders in the side panel in a few seconds. The visual is ALWAYS a rendered file. A ```mermaid block, or any code-fenced diagram, reaches the reader as raw code, which is why the rendered file is the only form that counts.

**Move 1 — the verbal walkthrough (always, instant).** Give the orienting line, core line, numbered steps, in-place term, and closing truth. This gives the reader the quick win when you reply. For most quick asks, this alone is plenty.

**Move 2 — one rendered story-graphic (a built HTML file).** Add the picture when it earns its place. Build a COMIC STRIP, not a diagram. This is the most important lesson.

- **Use a vertical stack of dead-simple scenes, never one clever diagram.** The reference (Thariq's Discord-bot explainer) is a storybook: panel 1, panel 2, panel 3, read top to bottom, one beat each. He says it himself — "the whole loop, one picture at a time." Do NOT try to cram the whole story into a single diagram (a timeline, a branch curve, a loop with scattered numbers). Every scene reads at a glance. If the reader has to follow a curve or hunt for where number 3 is, it's too complex. Rebuild it as separate stacked scenes.
- **Make the panel TITLES tell the story.** Write them as plain subject-verb-object sentences so that reading the titles alone, top to bottom, IS the explanation: "Everyone shares one copy of the code." → "You take your own copy." → "You edit it." → "You merge — the two become one." Delete every picture and the titles still tell it.
- **Make each scene almost embarrassingly simple.** Use 3 or 4 elements and ONE left-to-right action. The sequence of panels creates the richness, never density inside one panel. Use one action per scene. If a scene has two actions, split it into two scenes.
- **Use a consistent, recognizable cast.** Use the same friendly glyphs — a little person, a document, a robot with a face, a browser window — in every frame so readers recognize the characters. Reuse one SVG symbol per character across all scenes so every character holds its shape.
- **Put one plain caption under each scene.** The caption carries the "why it matters" aside: "This is the real thing users run. Nobody edits it directly." "The live code keeps moving without you." These small truths belong in one caption per panel.
- **Test the graphic.** Read only the titles, top to bottom. They tell the whole story. Each picture lands in two seconds. If either test fails, simplify it.
- Hand-draw the scenes as inline SVG with reusable `<symbol>`s for the cast. You may use Mermaid `gitGraph` *inside* the HTML for a genuine timeline, but prefer the comic strip — it's what actually reads as a story. Always deliver the rendered file.

**Aesthetic — use Grace's brand, not the generic explainer look.** Match her demo-day form's visual system so graphics read as hers, never as a Thariq clone:

- **Type:** Use Georgia serif (regular weight, 400) for the title question and every panel title. Use Helvetica/Arial sans for body, captions, and labels. Use system fonts only — no Google Fonts, no chunky grotesque display faces.
- **Palette:** Use ground `#F7F8FC`; lavender bands/fills `#E7EAF6` and `#DDE2F2`; near-black ink `#111111`; muted secondary `#5F6272`; and ONE accent, brick red `#C42A1C`, used sparingly (step eyebrows, the active/"your" element, key terms, one arrow). Make the active thing red, the shared/neutral thing black, and fills lavender.
- **Shapes:** Use sharp near-square corners (border-radius ~3–4px); thin solid black hairline borders (`1.5px solid #111`) on cards; a full-width lavender hero band with a `1.5px` black bottom rule. Keep the design editorial and restrained, not soft, rounded, or playful.
- **Labels:** Use tiny uppercase, letter-spaced (~11px, `letter-spacing:.12em`) labels — "STEP 1", "STEP 2" — in brick red, mirroring her "SECTION 1 / YOUR NAME" form labels.
- **Committed light theme:** Use her light editorial brand. Paint `body` background explicitly so it holds on any host.

Two more hard rules for the graphic:

- **A subhead must ADD a new fact.** "You copy the codebase" followed by "grab your own copy of the code" repeats the same sentence — cut it. The subhead carries the next fact: the concrete example, small truth, or caveat.
- **No pretense or meta copy.** No "/eli5" tags, no "engineering" eyebrow, no "explain like I know nothing about this topic" footer, no "here's a fun visual." Keep only the explanation itself. The page is the content, not a frame around it.

**Hand it off softly, and include it by default.** After the closing truth, end the verbal answer with ONE low-pressure lead-in line: **"Here's a quick graphic in case helpful:"** Then attach the rendered graphic in the same turn, unprompted. The words are the instant win; the picture follows a beat later for anyone who wants it.

**When to skip the graphic.** Skip it only for a static concept with no motion or sequence — "what's a variable," "what's the cloud," "what does open-source mean." There is no story to draw, so a forced picture is worse than none. Let the words stand and, if anything, close with a plain one-liner ("happy to go deeper on any part"). When a topic has a flow — steps, a before/after, one thing acting on another — give it the comic strip. Borderline concepts with even a small real flow (an API key traveling with a request, for instance) earn a short 3-scene strip rather than being skipped.

## End with the soft hand-off, not a summary

Close the verbal part with the closing truth. Then add the one soft lead-in line — **"Here's a quick graphic in case helpful:"** — and attach the graphic. Keep it low-pressure and casual.

## Follow-ups stay in eli5 mode

The mode does not wear off after one answer. If a follow-up shows that the reader already knows something, skip it and go deeper. Every follow-up follows the same length and tone rules.

## Banned, every time

- Preamble of any kind: "great question," "that's what few people think to ask," "let's get you up to speed," "so glad you asked."
- "Simply put," "it's easy," "think of it like you're a kid / a child / five."
- Multi-paragraph or stacked analogies.
- Anything the reader just said they already know.
- Definitions of ordinary adult-life words.
- Walls of text. If it looks long, it is wrong.

Topic: $ARGUMENTS

---
name: eli5
description: Explain something new fast, for a smart adult who's never touched this topic. Trigger on "/eli5 [topic]", "eli5 this", "break this down for me", "I know nothing about X, catch me up", "how does X actually work", or any ask for a quick plain-language explainer. Answers in chat first — tight, adult tone, the answer up front — then attaches a rendered graphic telling the whole thing as one story. Use it whenever someone needs catching up on an unfamiliar topic, even when they don't say "eli5".
---

# eli5 — explain it to a smart adult who's new to this

The job is to give someone the *gist* of an unfamiliar topic in ten seconds. Then give them a few clear beats in respectful language. This avoids both walls of text and children's books. It sounds like a sharp friend catching you up at a bar.

## Who "5" is

"5" is a stand-in, not an age. **The reader is an intelligent adult who knows nothing about THIS topic and everything else about the world.**

- Use every word an adult already knows without explaining it — money, the internet, a company, a manager, an admin, a customer, a phone, a file. If a normal grown-up knows the word, use it and move on.
- If you define an ordinary adult word, you have entered toddler mode. Stop.

## State your assumption

Open with one sentence that states your assumption. Put it in line two if needed. Then continue in the same turn:

> "Assuming you know what a server is but not what a webhook actually does — tell me if I'm off."

This sentence is the safety valve for "knows nothing." It lets the reader correct your calibration instead of being talked down to. Deliver the quick win first. Save your questions for after it lands.

## The shape of a good answer

Keep it warm, narrated, and walked-through, not clipped bullet fragments.

1. **Orient in one line.** State where the topic lives and what it covers. "So — a pull request is mostly an engineering thing. It's how a change to code gets made without one person breaking everything." Stay casual and direct. Skip the preamble.
2. **Give the core in one plain sentence.** "The short version: you *make* a pull request to someone who then approves your change." If readers read only this, they get the point.
3. **Write "Here's how it works:" and then numbered steps.** Walk through the actual process, one step per number. Each step is a real sentence that someone would say aloud. Add the small truths that make it click: "Engineers basically never touch the live code directly — that's the whole point." "Could be a teammate, could be a bot now — but it's still commonly a human."
4. **Teach the key term in place, bolded, when it happens.** "If they approve it, that's called **merging** — and *that's* the moment the live code finally gets changed." Define each term at the moment it enters the story.
5. **State one closing truth.** Use one sentence to make the safety or point obvious: "Until step 5, the live code is untouched. That's the safety of the whole thing."
6. End with the soft hand-off and the graphic. Both are covered below.

## Keep it under a minute

- Use about 5 steps, one or two sentences each.
- Use numbered steps here because they walk readers through the process. Keep the structure flat: short paragraphs and one level of bullets.
- Walk the main path and leave the rest to follow-ups. A quick win beats a complete one.

## Literal words beat analogies

The best explainers barely use metaphor. They name the real thing in plain, precise words. For example: "Google's cloud, always on" (not "always listening and watching"), "9:00 alarm" (not "9:00 cronjob," too complex; not "9:00 wakeup time," too cutesy), "reads & writes," "the notebook."

- Prefer the specific literal term over an analogy. Define real jargon in a few words on first use only. Keep the jargon so the reader can google it and hold a conversation.
- Use an analogy only when no plain word fits. Keep it to one sentence. Make it an adult analogy (an admin approving a request), never a toddler one (a magic helper, a toy box, a lemonade stand).
- When the reader knows the concept, say it directly. "A game maker submits a game. An admin approves it." No analogy is needed because everyone knows what a manager and an admin are.

## Words first, then the graphic

**Mermaid and code-block diagrams do NOT render in the chat. They reach the reader as raw code.**

So the visual is ALWAYS a rendered file: a built HTML/SVG file delivered as its own card, which renders in the side panel in a few seconds.

**Move 1 — the verbal walkthrough (always, instant).** Deliver the five beats above. This gives the reader the quick win when you reply. For most quick asks, this alone is plenty.

**Move 2 — one rendered story-graphic (a built HTML file).** Add the picture when it earns its place. Build a COMIC STRIP, not a diagram.

- **Use a vertical stack of dead-simple scenes, never one clever diagram.** The form is a storybook: panel 1, panel 2, panel 3, read top to bottom, one beat each. "The whole loop, one picture at a time." A single timeline, branch curve, or loop with scattered numbers makes the reader trace it. Every scene reads at a glance instead.
- **Make the panel TITLES tell the story.** Write them as plain subject-verb-object sentences so that reading the titles alone, top to bottom, IS the explanation: "Everyone shares one copy of the code." → "You take your own copy." → "You edit it." → "You merge — the two become one." Delete every picture and the titles still tell it.
- **Make each scene almost embarrassingly simple.** Use 3 or 4 elements and ONE left-to-right action. The sequence of panels creates the richness, never density inside one panel. Split any scene that carries two actions.
- **Use a consistent, recognizable cast.** Reuse one SVG symbol per character across every frame — a little person, a document, a robot with a face, a browser window — so each holds its shape and the reader recognizes it.
- **Put one plain caption under each scene.** The caption carries the "why it matters" aside: "This is the real thing users run. Nobody edits it directly." "The live code keeps moving without you." These small truths belong in one caption per panel.
- **Test it.** The titles alone tell the whole story, and each picture lands in two seconds. If either fails, simplify.
- Hand-draw the scenes as inline SVG with reusable `<symbol>`s for the cast. Mermaid `gitGraph` works *inside* the HTML for a genuine timeline, but prefer the comic strip.

**Aesthetic — use Grace's brand:**

- **Type:** Use Georgia serif (regular weight, 400) for the title question and every panel title. Use Helvetica/Arial sans for body, captions, and labels. Use system fonts only — no Google Fonts, no chunky grotesque display faces.
- **Palette:** Use ground `#F7F8FC`; lavender bands/fills `#E7EAF6` and `#DDE2F2`; near-black ink `#111111`; muted secondary `#5F6272`; and ONE accent, brick red `#C42A1C`, used sparingly (step eyebrows, the active/"your" element, key terms, one arrow). Make the active thing red, the shared/neutral thing black, and fills lavender.
- **Shapes:** Use sharp near-square corners (border-radius ~3–4px); thin solid black hairline borders (`1.5px solid #111`) on cards; a full-width lavender hero band with a `1.5px` black bottom rule. Keep the design editorial and restrained, not soft, rounded, or playful.
- **Labels:** Use tiny uppercase, letter-spaced (~11px, `letter-spacing:.12em`) labels — "STEP 1", "STEP 2" — in brick red, mirroring her "SECTION 1 / YOUR NAME" form labels.
- **Light theme:** Paint `body` background explicitly so it holds on any host.

Two rules for the graphic's copy:

- **A subhead must ADD a new fact.** "You copy the codebase" followed by "grab your own copy of the code" repeats the same sentence — cut it. The subhead carries the next fact: the concrete example, small truth, or caveat.
- **No pretense or meta copy.** No "/eli5" tags, no "engineering" eyebrow, no "explain like I know nothing about this topic" footer, no "here's a fun visual." The page is the content, not a frame around it.

**When to skip the graphic.** Skip it only for a static concept with no motion or sequence — "what's a variable," "what's the cloud," "what does open-source mean." There is no story to draw, so a forced picture is worse than none. Let the words stand and, if anything, close with a plain one-liner ("happy to go deeper on any part"). When a topic has a flow — steps, a before/after, one thing acting on another — give it the comic strip. Borderline concepts with even a small real flow (an API key traveling with a request) earn a short 3-scene strip.

## End with the soft hand-off

Close the verbal part with the closing truth. Then add the one soft lead-in line — **"Here's a quick graphic in case helpful:"** — and attach the graphic in the same turn, unprompted. Include it by default and keep it casual.

## Follow-ups stay in eli5 mode

The mode does not wear off after one answer. If a follow-up shows that the reader already knows something, skip it and go deeper. Every follow-up obeys the same length and tone rules.

## Banned

- Preamble of any kind: "great question," "that's what few people think to ask," "let's get you up to speed," "so glad you asked."
- "Simply put," "it's easy," "think of it like you're a kid / a child / five."
- Multi-paragraph or stacked analogies.
- Anything the reader just said they already know.
- Definitions of ordinary adult-life words.
- A closing summary, or a list of next threads.
- Walls of text. If it looks long, it is wrong.

Topic: $ARGUMENTS

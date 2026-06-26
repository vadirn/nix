---
type: note
description: A short discipline for getting your pull request reviewed quickly, and the one rule reviewers care about most
---

# Getting a pull request reviewed

A pull request is a request for someone else's attention, and attention is the scarcest thing on an engineering team. People imagine that the hard part of code review is the judgement — deciding whether the code is correct, whether the design holds, whether the tests are enough. In practice that is rarely where the time goes. Most of the friction in code review is not disagreement about the code at all; it is the reviewer not knowing what changed, not knowing why, and not knowing where they are supposed to respond. The author has all of that context loaded in their head and silently assumes the reviewer does too. The reviewer, opening a wall of diff cold, has none of it. The gap between those two states is where days disappear.

That gap has two halves, and they close in different ways. One half is what the reviewer could work out for themselves by reading carefully — the mechanics of the change, sitting right there in the diff. The other half is what no amount of reading recovers: why you took an approach, what you ruled out, what a surprising line is actually doing. The first half closes when the reviewer inspects. The second half closes only when the author writes it down somewhere the reviewer will actually encounter it. Getting reviewed quickly is mostly about closing the second half cheaply, and the habits below are how.

## Practices

1. **Open the review with a one-paragraph summary of what changed and why.** A diff tells the reviewer what the code does now; it does not tell them what problem you were solving or which alternatives you rejected. Without that frame they infer intent from mechanism, which is slow, and they will flag deliberate choices as mistakes because the reasoning was never stated. The summary is the frame; the diff is the detail.

2. **Keep each pull request under roughly 400 lines of change.** A reviewer can hold a small diff in their head and trace each change to its purpose in one sitting. Past a few hundred lines attention fragments, real defects slip through, and the comments that do get written are the trivial ones about naming, because those are the only things a tired reader still catches. A large pull request gets a shallower review, not a deeper one.

3. **Record each decision where the reviewer is already reading, not where they would have to go and look.** A reviewer opening the team wiki is a reviewer bearing the cost of going to find it; a reply written into the open review is the author bearing the cost of putting it in reach. The latter keeps the review moving; the former leaves it stalled. The same sentence, pinned under the question that prompted it, changes the review happening today; filed on a durable page it changes a review that may never happen.

4. **Reply to every review comment, even if only to acknowledge it.** A comment left with no reply is ambiguous in the worst way: the reviewer cannot tell whether you disagreed, fixed it, or never saw it. Silence reads as ignored, and an ignored reviewer reviews more slowly and more grudgingly next time. A one-word acknowledgement costs nothing and keeps the loop closed.

5. **Re-request review explicitly once you have pushed your fixes.** Do not assume the reviewer is quietly watching the branch for new commits; they have a dozen other things open. A re-request is a fresh notification in the place they actually trigger their work from, while a silent push is invisible — it sits for a day until someone wanders back, and that day is dead time nobody chose.

None of this is about writing more. Every habit here is about writing less, and putting the few words you do write where the reader already is, while they are still here to read them.

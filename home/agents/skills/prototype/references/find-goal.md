# Find the goal when the design question is missing

Use when the user invokes `/prototype` but cannot state the design question in one sentence. The cause is usually one of: the user has a solution in mind but not a problem, the user has a vague feeling that something is wrong, or the user has copied a request from elsewhere and not internalised it.

This workflow extracts a stateable design question. If it cannot, the prototype is premature; recommend stopping.

## Symptoms that this workflow is needed

- The user describes a method instead of a question. ("Let's prototype Redis." Redis is the answer; what is the question?)
- The user describes a feeling instead of a problem. ("The app feels slow." Where, for whom, doing what, slower than what?)
- The user describes an outcome two steps removed. ("We need to increase retention.") Retention is a goal; the design question is the next layer down.
- The user can describe the prototype but not what the prototype would _prove_.

## Procedure

Run the four steps in order. Stop as soon as a clean one-sentence design question emerges.

### 1. Strip the method to find the goal

The user often hands you the answer disguised as the question. Ask:

> "Suppose <method> is impossible. What would you do instead, and what would still be true?"

What is "still true" is the goal. Method examples and what they hide:

- "Prototype Redis" → goal: reduce read latency below X ms.
- "Prototype a chatbot" → goal: let users get answer Y without opening a ticket.
- "Prototype migrating to gRPC" → goal: cut serialisation overhead, or unblock streaming, or some other property gRPC supplies.

If the user can name a goal that survives the strip, the design question follows directly: "Does <method> deliver <goal>?". That is an implementation question; the prototype is a spike.

### 2. Five Whys, capped at three

When the request is a feeling or a downstream outcome, ask "why" up to three times. Each "why" pulls the goal closer to a stateable design question.

- User: "We need to prototype faster onboarding."
- Why is current onboarding too slow? → "New users drop off in the first session."
- Why do they drop off? → "They hit a wall configuring the integration."
- Why is the integration hard? → "They have to copy-paste credentials between three screens."

Three whys is enough. The design question is now: "What does a one-screen credential flow feel like to use?" That is a look-and-feel question.

If five whys are needed, the problem is fuzzier than a prototype can resolve. Recommend user research, not prototyping.

### 3. Name the harm

For each candidate question, ask:

> "If the prototype is not built, what bad thing happens? Who feels it? When?"

A real goal has a real harm. If the user cannot name the harm, the prototype is decoration. Push back: "The prototype answers a question. What question is worth your time?"

If the harm is named ("if we do not validate this, we will build six weeks of features on a stack that cannot scale, and we find out at launch"), the design question is the inverse of the harm. The harm names what must not be true; the question asks whether it is true.

### 4. Acceptance test

For each candidate question, ask:

> "I will know this prototype answered the question when \_\_\_."

Fill the blank with the user. A clean answer makes the design question precise:

- "When latency under load X is below Y ms in 10 consecutive runs." → implementation, spike.
- "When three users complete task Z in one session without help." → role, Wizard of Oz.
- "When the deploy artifact reaches staging from a git push without manual steps." → integration, walking skeleton.
- "When the team agrees the new API shape is easier to call than the old one." → look-and-feel, design + memo.

If the blank cannot be filled, the question is not ready. Either iterate on this workflow once more or stop and recommend the user spend an hour writing a one-page problem statement before reaching for prototyping.

## Output

Hand back to the main pseudocode with a single sentence in one of the four shapes:

- "Does X work?" (implementation)
- "What does Y feel like to use?" (look-and-feel)
- "How should Z behave from the user's side?" (role)
- "Do these pieces talk to each other?" (integration)

If no question emerges after this workflow, the right action is to stop the prototype invocation, write a problem statement, and return later. Say so explicitly to the user.

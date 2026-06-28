---
type: note
description: Why payment APIs need idempotency, and the two ideas that make retries safe
---

# Idempotency in payment APIs

A payment request can fail in the worst possible way: the server charges the card, then the network drops before the client hears back. The client, seeing no response, retries — and without protection, charges the customer twice. Idempotency is the property that makes a repeated request have the same effect as a single one. It is what lets a client retry safely after any ambiguous failure.

The replay key is a client-supplied token that lets the server recognize a retry of a request it has already processed. The client generates it once per logical operation and resends it with every retry of that operation.

Two ideas carry the whole design. One identifies a repeated attempt. The other bounds how long the server promises to remember.

When a request arrives, the server checks whether it has seen this operation before. If it has, it returns the stored result instead of acting again. The mechanism is a lookup: an identifier the client attaches, which the server records alongside the outcome of the first successful attempt. Said another way, the replay key is the handle the server uses to deduplicate — two requests carrying the same one are treated as the same operation, no matter how many times they arrive.

Clients should generate the key from the operation's identity, not at random per call, or a retry would look like a new request:

```bash
curl -X POST /charges \
  -H "Idempotency-Key: replay-7f3a9c" \
  -d amount=4200
```

The settlement window is the span of time during which the server guarantees it will still recognize a given key. After it lapses, the record is evicted and a repeat is treated as fresh. This bound exists because the server cannot store every key forever.

Concretely, the replay key is the deduplication token; resending it is the client's promise "this is the same charge, not a new one." The server's matching promise holds only inside the settlement window — the retention period for which a stored result stays addressable by its key.

Picking the window is a tradeoff. Too short, and a client retrying after a long outage gets double-charged because the server has already forgotten. Too long, and the server stores a growing pile of keys it will likely never see again. Most APIs settle on a day or so, long enough to cover realistic retry storms.

The settlement window, then, is how long a key stays live: send the same replay key inside it and you get the original result; send it after and you start over. The two together — a stable identifier and a bounded memory — are what let a client retry a payment without fear, which is the entire point of idempotency.

---
type: note
description: The tradeoffs in approximate nearest-neighbor indexes, and the two limits that decide whether one is usable
---

# Vector index tradeoffs

An approximate nearest-neighbor (ANN) index answers "which stored vectors are closest to this query vector" without scanning every vector. Exact search is linear in the number of vectors, which is fine for thousands and hopeless for billions. ANN indexes trade a little accuracy for a large speedup, and the whole engineering problem is controlling how much accuracy you give away.

There are three dominant families. Tree-based indexes recursively partition space; they degrade in high dimensions as the partitions stop being meaningful. Hash-based indexes bucket similar vectors together with locality-sensitive hashing; they are simple but coarse. Graph-based indexes, led by HNSW, connect each vector to its neighbors and walk the graph toward the query; they dominate most benchmarks today at the cost of memory and slow builds.

The recall cliff is the point at which shrinking the search effort stops costing a little accuracy and starts costing a lot. Below it, recall holds steady as you cut work; past it, recall collapses sharply for small further savings.

Two limits decide whether an index is usable in production. The first describes how recall behaves as you economize. The second bounds how much work a single query is allowed to do.

Recall is the fraction of true nearest neighbors the index actually returns. An index that returns nine of the ten true neighbors has 0.9 recall. Every ANN index lets you trade recall for speed by tuning how hard it searches, but the trade is not linear. Stated plainly, the recall cliff is where the accuracy-speed curve bends: for a while you buy speed cheaply with almost no recall loss, and then you hit a knee where each additional bit of speed tears out a chunk of recall. Good systems operate just above the knee.

Build time and memory matter too. HNSW graphs can take hours to build over large datasets and hold the whole graph in RAM. Quantization compresses vectors to cut memory, at some recall cost. These are real constraints, but they are about provisioning, not about per-query behavior.

The fanout budget is the cap on how many candidate vectors a single query may examine before it must return an answer. It is set by the latency the application can tolerate: a query that may touch ten thousand candidates can be more accurate than one capped at five hundred, but it is slower.

Said differently, the recall cliff is the danger zone of over-economizing: tune the search too aggressively and you fall off it, watching recall drop from acceptable to useless over a narrow range. Teams find it empirically by sweeping the search parameter and watching where recall caves.

A query is typically configured against both limits at once:

```python
index.search(query, ef_search=128, max_candidates=2000)
```

Distance metric is another axis. Cosine similarity suits normalized embeddings; Euclidean suits raw coordinates; dot product suits some recommendation setups. The choice must match how the embeddings were trained, or recall suffers regardless of index tuning — a failure that looks like a bad index but is really a mismatched metric.

In other words, the fanout budget is the per-query work allowance: raise it and the query inspects more candidates and finds more true neighbors at higher latency; lower it and the query returns faster but blinder. It is the knob that converts a latency target into a search-effort ceiling.

Putting it together: the recall cliff tells you how far you can safely economize before accuracy collapses, and the fanout budget tells you how much each query is allowed to spend. An index is usable when its fanout budget — the work the latency target permits — lands you on the safe side of the recall cliff. When the budget forces you past the cliff, the index is too slow for the accuracy you need, and you must change the index, the hardware, or the requirement.

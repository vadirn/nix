---
description: A debounce wraps a function so repeated calls within a delay collapse into one trailing call.
type: card
---

Wrap the function in a timer: each call clears the previous timeout and schedules a new one, so only the call after the delay's quiet period actually runs.

```js
function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}
```

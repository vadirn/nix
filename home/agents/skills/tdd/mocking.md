# Mocking

## When to Mock

Mock at system boundaries only:

- **External APIs** — HTTP calls to third-party services
- **Databases** — when using a real DB is impractical for the test
- **Time** — `Date.now()`, timers, scheduling
- **Filesystem** — when tests should stay off disk
- **Randomness** — `Math.random()`, UUIDs

These are things you can't control or make deterministic without mocking.

## Keep Mocks Out of Your Own Code

Mock only what you own the boundary to. If you need to mock an internal module to test another module, the design has a coupling problem. Fix the design.

Bad:

```ts
// Mocking your own OrderService to test CheckoutService
const mockOrderService = jest.mock("./orderService");
mockOrderService.create.mockResolvedValue({ id: "123" });
await checkoutService.process(cart);
expect(mockOrderService.create).toHaveBeenCalled();
```

Good:

```ts
// Use real OrderService, mock only the external payment API
const mockPaymentAPI = jest.mock("./adapters/stripeClient");
mockPaymentAPI.charge.mockResolvedValue({ status: "ok" });

const result = await checkoutService.process(cart);
expect(result.orderId).toBeDefined();
```

## Dependency Injection for Mockability

Accept dependencies as arguments. This makes mocking at boundaries natural.

```ts
// Accepts the HTTP client — easy to swap for tests
function createUserService(httpClient: HttpClient) {
  return {
    async getUser(id: string) {
      const response = await httpClient.get(`/users/${id}`);
      return parseUser(response);
    },
  };
}

// Test with a fake HTTP client
const fakeHttp = { get: async () => ({ name: "Alice", id: "1" }) };
const service = createUserService(fakeHttp);
const user = await service.getUser("1");
expect(user.name).toBe("Alice");
```

## SDK-Style Interfaces Over Generic Fetchers

Wrap external systems in typed interfaces that describe what your app needs. Test against those interfaces.

Bad:

```ts
// Generic fetcher — hard to mock, leaks HTTP details
async function getUser(id: string) {
  const res = await fetch(`https://api.example.com/users/${id}`);
  return res.json();
}
```

Good:

```ts
// SDK-style interface — describes capability, not transport
interface UserAPI {
  getUser(id: string): Promise<User>;
}

// Production implementation
const httpUserAPI: UserAPI = {
  async getUser(id) {
    const res = await fetch(`https://api.example.com/users/${id}`);
    return res.json();
  },
};

// Test implementation
const fakeUserAPI: UserAPI = {
  async getUser(id) {
    return { id, name: "Alice" };
  },
};
```

The interface makes the boundary explicit. Swap `httpUserAPI` for `fakeUserAPI` in tests without touching application logic.

# Good vs Bad Tests

## Good Tests

Exercise real code through public interfaces. Describe WHAT the system does. Survive internal refactors unchanged. Read like specifications.

```ts
// Tests observable behavior through the interface
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);

  const result = await checkout(cart, paymentMethod);

  expect(result.status).toBe("confirmed");
});
```

"User can checkout with valid cart" tells you exactly what capability exists. This test survives a complete internal refactor because it only touches the public interface.

```ts
// Tests edge case behavior
test("checkout rejects empty cart", async () => {
  const cart = createCart();

  const result = await checkout(cart, paymentMethod);

  expect(result.status).toBe("rejected");
  expect(result.reason).toBe("cart is empty");
});
```

## Bad Tests

Coupled to implementation. Mock internal collaborators, test private methods, verify through external means.

```ts
// BAD: mocks internal collaborator
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Asserts that `paymentService.process` was called with `cart.total`. Rename or restructure `paymentService` and this test breaks, even though checkout still works.

```ts
// BAD: bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});
```

Queries the database directly. Use the system's own read path (`getUser("Alice")`) instead.

```ts
// BAD: tests implementation shape
test("cart has items array", () => {
  const cart = createCart();
  expect(cart.items).toEqual([]);
});
```

Tests a data structure. Change `items` to a `Map` and this breaks, even though `cart.add()` and `cart.total` still work.

## Warning Sign

A test breaks when you refactor, but behavior stays the same. Renaming an internal function causes test failures — those tests tested implementation.

## Summary

| Good Tests                                   | Bad Tests                                               |
| -------------------------------------------- | ------------------------------------------------------- |
| Exercise real code through public interfaces | Mock internal collaborators                             |
| Describe WHAT the system does                | Test HOW it's implemented                               |
| Survive internal refactors unchanged         | Break on refactoring without behavior change            |
| Read like specifications                     | Test the shape of data structures                       |
| Focus on user-facing behavior                | Verify through external means (DB queries, call counts) |

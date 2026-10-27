---
name: properties-of-good-tests
description: "Use when writing, reviewing, or critiquing tests. The 9 properties every good test has (Beck, Fowler, Meszaros, Feathers)."
category: software-development
---

# Properties of a Good Test

*(From Kent Beck, Martin Fowler, Gerard Meszaros, Michael Feathers, et al.)*

When writing or reviewing tests — whether unit, integration, or acceptance — every test should exhibit these 9 properties. Violating any one creates friction that compounds over time.

---

## 1. Fast

Tests must run in milliseconds so you run them constantly.

**Why:** Slow tests break the feedback loop. If the suite takes 5 minutes, developers batch changes and lose the red-green-refactor rhythm.

**Code example (Python):**

```python
# ✅ FAST — in-memory repository, no I/O
class InMemoryOrderRepo:
    def __init__(self):
        self._orders = {}

    def save(self, order):
        self._orders[order.id] = order

    def find(self, order_id):
        return self._orders.get(order_id)


def test_order_total_uses_quantity_times_price():
    repo = InMemoryOrderRepo()
    order = Order(id="1", items=[Item(price=10, qty=3)])
    repo.save(order)

    result = repo.find("1")
    assert result.total() == 30  # sub-millisecond, no DB


# ❌ SLOW — hits real Postgres per test
def test_order_total_slow():
    conn = psycopg2.connect("dbname=orders")
    conn.execute("INSERT INTO orders ...")  # disk I/O, TCP
    ...
```

**TypeScript equivalent:**

```typescript
// ✅ In-memory stub
const repo = new Map<string, Order>();
repo.set("1", makeOrder({ items: [{ price: 10, qty: 3 }] }));
expect(repo.get("1")!.total()).toBe(30);
```

---

## 2. Isolated / Independent

Each test sets up its own world, fails for exactly one reason, and doesn't depend on run order.

```python
# ✅ Each test owns its fixture — run in any order
def test_push_adds_to_top():
    stack = Stack()
    stack.push(42)
    assert stack.peek() == 42


def test_pop_removes_top():
    stack = Stack()
    stack.push(1)
    stack.push(2)
    assert stack.pop() == 2


# ❌ Shared mutable state — Test B depends on Test A's side effect
shared_stack = Stack()

def test_a_push():
    shared_stack.push(99)

def test_b_peek():
    assert shared_stack.peek() == 99  # Fails if test_a didn't run first
```

---

## 3. Repeatable / Deterministic

Same result every time, on any machine, regardless of timezone or network.

```python
# ✅ Inject a clock — test controls time
def test_subscription_expires_after_30_days(fake_clock):
    fake_clock.now = datetime(2024, 1, 1)
    sub = Subscription(started=fake_clock.now)

    fake_clock.advance(days=31)
    assert sub.is_expired(fake_clock.now) is True


# ✅ Seed randomness
def test_shuffle_is_deterministic():
    rng = Random(seed=42)
    deck = Deck(rng=rng)
    deck.shuffle()
    assert deck.top() == Card("7♠")  # always, given seed 42


# ❌ Hits live API — flakes on rate limits, network, or data changes
def test_weather_api():
    resp = requests.get("https://api.weather.com/today")
    assert resp.status_code == 200  # Will fail on airplane mode
```

---

## 4. Self-Validating

Pass or fail — no human interpretation needed. Green means correct; red means broken.

```python
# ✅ Binary verdict with clear message
def test_invoice_marked_paid_on_full_payment():
    invoice = Invoice(amount=100)
    invoice.apply_payment(100)
    assert invoice.status == "PAID", f"Expected PAID, got {invoice.status}"


# ❌ Prints output for a human to eyeball
def test_report():
    report = generate_report()
    print(report)  # "looks right to me" is not a test
```

---

## 5. Timely (Written First)

Beck's core TDD rule — write the test *before* the code. The test drives interface design.

```python
# RED: write the test first — it fails because calculate_tax doesn't exist yet
def test_tax_is_20_percent_of_subtotal():
    assert calculate_tax(subtotal=100, rate=0.20) == 20.0


# GREEN: write the minimal implementation
def calculate_tax(subtotal: float, rate: float) -> float:
    return subtotal * rate


# REFACTOR: clean up if needed (here it's already clean)
```

**Benefits of writing first:**
- You discover awkward APIs before committing to them
- You can't write untestable code (the test *is* the first client)
- You get 100% coverage for free — every line was written to satisfy a test

---

## 6. Tests Behavior, Not Implementation

Assert *what* the system does, not *how* it does it internally.

```python
# ✅ Tests the WHAT — doesn't care if it loops, uses reduce, or caches
def test_cart_total_sums_item_prices():
    cart = Cart(items=[Item(price=10), Item(price=20)])
    assert cart.total() == 30


# ❌ Tests the HOW — breaks when you refactor internals
def test_cart_calls_price_calculator(mocker):
    calc = mocker.patch("cart.PriceCalculator.sum_items")
    cart = Cart(items=[Item(price=10)])
    cart.total()
    calc.assert_called_once_with([Item(price=10)])  # Breaks if you inline the logic
```

**Fowler's rule:** "Don't mock what you don't own." Test at the boundary.

---

## 7. Readable / Acts as Documentation

A test should tell a story in three acts: **Arrange → Act → Assert**. The name states the business rule.

```python
# ✅ Name is the spec; three clear sections
def test_expired_coupon_is_rejected():
    # Arrange
    coupon = Coupon(code="SAVE10", expires=date(2024, 1, 1))
    order = Order(total=50)

    # Act
    result = order.apply_coupon(coupon, today=date(2024, 1, 2))

    # Assert
    assert result.discount == 0
    assert result.error == "Coupon expired"


# ❌ Cryptic, dense, unclear what's being tested
def test_c1():
    x = f(Object(a=1, b=2, c=3, d=4, e=5, f=6, g=7, h=8), "SAVE10", True, None)
    assert x[0] == 0 and x[1] == "err"
```

---

## 8. Minimal & Sufficient

Test exactly what matters — no more setup, data, or assertions than needed.

```python
# ✅ Only set fields that affect the outcome
def test_user_display_name_uses_first_and_last():
    user = User(first_name="Ada", last_name="Lovelace")
    assert user.display_name() == "Ada Lovelace"
    # Don't set email, age, address — irrelevant to this test


# ❌ Kitchen-sink fixture
def test_user_display_name_over_engineered():
    user = User(
        first_name="Ada", last_name="Lovelace",
        email="ada@example.com", age=36,
        address="123 Math Lane", phone="555-0100",
        role="admin", created_at=datetime.now(),
    )
    assert user.display_name() == "Ada Lovelace"
```

**Meszaros calls this "relevant, minimal fixture."** Noise obscures intent.

---

## 9. Sensitive to Defects, Insensitive to Refactoring

Breaks when behavior breaks; stays green when you restructure internals.

```python
# ✅ Contract test at the boundary — survives internal refactors
def test_payment_gateway_charges_correct_amount():
    gateway = FakePaymentGateway()
    checkout = Checkout(gateway=gateway)

    checkout.pay(order_id="abc", amount=50_00)

    assert gateway.last_charge.amount == 50_00
    assert gateway.last_charge.currency == "USD"


# ❌ Over-mocked — rename a private helper and 40 tests break
def test_checkout_calls_internal_validator(mocker):
    mocker.patch("checkout._validate_card_number")
    ...  # Coupled to private structure
```

**Beck's heuristic:** If a refactoring (behavior-preserving change) breaks a test, the test is wrong — not the code.

---

## Quick Reference (FIRST + 4)

| # | Property | One-liner |
|---|----------|-----------|
| 1 | Fast | Milliseconds, no I/O |
| 2 | Isolated | Own fixture, no shared state |
| 3 | Repeatable | Deterministic on any machine |
| 4 | Self-Validating | Pass/fail, no human needed |
| 5 | Timely | Written before the code |
| 6 | Behavior > Implementation | Assert what, not how |
| 7 | Readable | Arrange-Act-Assert, named as spec |
| 8 | Minimal | Only relevant data |
| 9 | Defect-sensitive | Breaks on bugs, not refactors |

---

## Sources

- Kent Beck — *Test-Driven Development: By Example* (2002)
- Martin Fowler — *Refactoring* (2018) & "Mocks Aren't Stubs" essay
- Gerard Meszaros — *xUnit Test Patterns* (2007)
- Michael Feathers — *Working Effectively with Legacy Code* (2004)
- Robert C. Martin — *Clean Code* (2008) — FIRST acronym

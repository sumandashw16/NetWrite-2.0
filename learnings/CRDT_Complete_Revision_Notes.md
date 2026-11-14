# CRDT Fundamentals --- Complete Revision Notes

> A practical theory guide to replicas, state-based CRDTs (CvRDTs),
> operation-based CRDTs (CmRDTs), lattices, merge properties, causal
> ordering, and replication topologies.
>
> **Context:** Collaborative applications such as real-time whiteboards,
> shared documents, and multiplayer editors.

------------------------------------------------------------------------

## Table of Contents

1.  [Why do we need CRDTs?](#1-why-do-we-need-crdts)
2.  [Distributed state and replicas](#2-distributed-state-and-replicas)
3.  [The two main CRDT families](#3-the-two-main-crdt-families)
4.  [State-based CRDTs --- CvRDTs](#4-state-based-crdts--cvrdts)
5.  [The mathematics behind CvRDTs](#5-the-mathematics-behind-cvrdts)
6.  [Join, meet, and least upper
    bound](#6-join-meet-and-least-upper-bound)
7.  [Why merge must be ACI](#7-why-merge-must-be-aci)
8.  [Inflationary (monotonic)
    updates](#8-inflationary-monotonic-updates)
9.  [A complete CvRDT example:
    G-Counter](#9-a-complete-cvrdt-example-g-counter)
10. [Operation-based CRDTs ---
    CmRDTs](#10-operation-based-crdts--cmdrts)
11. [Commutativity and operation
    ordering](#11-commutativity-and-operation-ordering)
12. [Causal ordering](#12-causal-ordering)
13. [Delta-state CRDTs --- an efficient form of state-based replication](#13-delta-state-crdts----an-efficient-form-of-state-based-replication)
14. [CvRDT vs CmRDT vs delta-state CRDT](#14-cvrdt-vs-cmdrtd-vs-delta-state-crdt)
15. [CvRDT vs CmRDT](#15-cvrdt-vs-cmdrtd)
16. [Replication topologies: star, mesh, and gossip](#16-replication-topologies-star-mesh-and-gossip)
17. [CRDTs in a collaborative whiteboard](#17-crdts-in-a-collaborative-whiteboard)
18. [Important corrections and common misconceptions](#18-important-corrections-and-common-misconceptions)
19. [Worked examples](#19-worked-examples)
20. [Revision questions](#20-revision-questions)
21. [Glossary](#21-glossary)

------------------------------------------------------------------------

# 1. Why do we need CRDTs?

Imagine several people editing the same whiteboard at the same time.

-   User A creates a rectangle.
-   User B creates a circle.
-   User C moves another shape.
-   Some users may temporarily lose their internet connection.
-   Updates may reach different devices at different times.

Each participant needs to work with a local copy of the shared data.
When updates are exchanged, the copies must be reconciled.

The central challenge is **concurrent modification**: multiple
participants can make changes without seeing one another's latest
changes.

A synchronization design should aim for:

-   **Eventual convergence:** replicas that have received the same
    relevant updates eventually reach equivalent states.
-   **Availability during disconnection:** depending on the design,
    users may continue making local changes while offline.
-   **Correct merging:** concurrent updates should not accidentally
    overwrite or lose one another.
-   **Reliable synchronization:** updates must eventually reach the
    replicas that need them.

A **Conflict-free Replicated Data Type (CRDT)** is a data type designed
with mathematical rules that allow replicas to merge concurrent changes
consistently.

CRDTs do not mean that every possible conflict disappears or that every
application automatically gets the behavior it wants. The data type and
its update rules must be designed carefully.

# 2. Distributed state and replicas

## 2.1 What is state?

The **state** is the data that represents the current contents of an
object or application.

For a whiteboard, state might contain:

``` js
{
  shapes: {
    "shape-1": {
      type: "rectangle",
      x: 100,
      y: 100,
      color: "blue"
    },
    "shape-2": {
      type: "circle",
      x: 300,
      y: 200,
      color: "red"
    }
  }
}
```

This data describes the current whiteboard.

## 2.2 What is a replica?

A **replica** is an independently maintained copy of shared data.

For example:

``` text
User A's browser: Replica A
User B's browser: Replica B
Backend process:  Replica S
```

Each can maintain its own copy of the same logical whiteboard.

A replica is not the same thing as a user. One user may have multiple
devices, and a server may also maintain a replica.

## 2.3 Why have replicas?

Replicas allow participants to:

1.  Read and update local data without waiting for every other
    participant.
2.  Continue working during temporary disconnections, if the application
    supports offline updates.
3.  exchange updates later.
4.  Avoid making one central machine the only place where the data can
    exist.

Example:

Initially:

``` text
Replica A: {Circle}
Replica B: {Circle}
```

While disconnected:

``` text
Replica A: {Circle, Rectangle}
Replica B: {Circle, Triangle}
```

After synchronization, a suitable CRDT can merge the changes so both
replicas contain:

``` text
{Circle, Rectangle, Triangle}
```

This example assumes the data type is designed so that adding these
independently identified shapes is mergeable.

## 2.4 State, replica, operation, and synchronization

  -----------------------------------------------------------------------
  Term                                Meaning
  ----------------------------------- -----------------------------------
  State                               The current data representing an
                                      object or document

  Replica                             An independently maintained copy of
                                      that state

  Operation / update                  A change made to the state

  Synchronization                     Communicating and incorporating
                                      changes between replicas

  Convergence                         Replicas eventually reach
                                      equivalent states
  -----------------------------------------------------------------------

**Important:** A replica is not necessarily sent to a server for
broadcasting. A replica is the local copy itself. Depending on the
architecture, it may exchange full states, deltas, or operations with
other replicas.

# 3. The two main CRDT families

There are two major CRDT approaches covered in these notes:

1.  **State-based CRDTs**, also called **CvRDTs**.
2.  **Operation-based CRDTs**, also called **CmRDTs**.

The key difference is what replicas communicate.

  -----------------------------------------------------------------------
  Feature                 CvRDT                   CmRDT
  ----------------------- ----------------------- -----------------------
  Full name               Convergent Replicated   Commutative Replicated
                          Data Type               Data Type

  Communication           States (or, in          Update operations
                          optimized variants,     
                          state deltas)           

  Receiver does           Merges received state   Delivers and applies
                          with local state        the received operation

  Main mathematical idea  Join / least upper      Concurrent operations
                          bound                   commute

  Typical communication   State updates           Reliable operation
  assumptions             eventually propagate    delivery and causal
                                                  ordering are commonly
                                                  required

  Network topology        Not prescribed by the   Not prescribed by the
                          CRDT model              CRDT model
  -----------------------------------------------------------------------

A third related approach is **delta-state CRDTs**, which send smaller
state deltas rather than repeatedly sending the full state. They are
still state-based in their merge model.

# 4. State-based CRDTs --- CvRDTs

## 4.1 Basic idea

In a state-based CRDT, a replica periodically sends its current state to
another replica.

The receiving replica merges the received state with its own local
state.

Conceptually:

``` text
Replica A                         Replica B
   |                                  |
   | ------ send state A ----------> |
   |                                  |
   |                         merge(B, A)
   |                                  |
   | <------ send state B ---------- |
   |                                  |
 merge(A, B)                          |
```

The merge function is designed so that replicas can incorporate
information safely even if states are received:

-   More than once.
-   In different orders.
-   In different groupings.

## 4.2 Example using sets

Suppose the state is a set of shapes.

Initially:

``` text
Replica A = {Circle}
Replica B = {Circle}
```

While disconnected:

``` text
Replica A = {Circle, Rectangle}
Replica B = {Circle, Triangle}
```

They exchange states and merge using set union:

``` text
A ∪ B = {Circle, Rectangle, Triangle}
```

Both can reach:

``` text
Replica A = {Circle, Rectangle, Triangle}
Replica B = {Circle, Rectangle, Triangle}
```

This is a simple grow-only set example.

**Caution:** Ordinary set union is suitable for a grow-only set. It does
not by itself correctly model arbitrary removals. Removal needs
additional CRDT design, such as tombstones or observed-remove semantics.

## 4.3 Does CvRDT require a central server?

No. CvRDT describes the data type and its merge behavior, not a required
network layout.

Possible designs include:

-   Peer-to-peer communication.
-   A central relay server.
-   A server that also stores a replica.
-   Gossip or anti-entropy protocols.

A server may persist snapshots or relay states without being the
exclusive authority for every edit.

# 5. The mathematics behind CvRDTs

To understand why state-based merging works, we need a few mathematical
ideas:

1.  Partial orders.
2.  Upper bounds.
3.  Least upper bounds.
4.  Join-semilattices.
5.  Idempotency, commutativity, and associativity.
6.  Inflationary updates.

## 5.1 Partially ordered set (Poset)

A **partially ordered set**, or **poset**, is a set equipped with a
relation `≤` satisfying three rules.

### Reflexivity

Every element is related to itself:

\[ a `\leq `{=tex}a \]

### Antisymmetry

If each of two elements is less than or equal to the other, they must be
equal:

\[ (a `\leq `{=tex}b) `\land `{=tex}(b `\leq `{=tex}a)
`\Rightarrow `{=tex}a=b \]

### Transitivity

If one element is below a second, and the second is below a third, the
first is below the third:

\[ (a `\leq `{=tex}b) `\land `{=tex}(b `\leq `{=tex}c)
`\Rightarrow `{=tex}a `\leq `{=tex}c \]

### Why is the ordering called partial?

Because not every pair of elements must be comparable.

Consider sets ordered by subset inclusion:

\[ A `\leq `{=tex}B `\quad `{=tex}`\text{means}`{=tex} `\quad `{=tex}A
`\subseteq `{=tex}B \]

Let:

``` text
A = {Circle, Rectangle}
B = {Circle, Triangle}
```

Neither A is a subset of B nor B a subset of A. They are incomparable
under this ordering.

That is allowed in a partial order.

## 5.2 Upper bound

An element U is an **upper bound** of A and B if both A and B are less
than or equal to U:

\[ A `\leq `{=tex}U `\quad `{=tex}`\text{and}`{=tex} `\quad `{=tex}B
`\leq `{=tex}U \]

For subset ordering, this means U must contain every element in both
sets.

Example:

``` text
A  = {Circle, Rectangle}
B  = {Circle, Triangle}

U1 = {Circle, Rectangle, Triangle}
U2 = {Circle, Rectangle, Triangle, Square}
```

Both U1 and U2 are upper bounds.

## 5.3 Least upper bound (LUB)

The **least upper bound** is the smallest upper bound according to the
ordering relation.

For the sets above:

``` text
LUB(A, B) = {Circle, Rectangle, Triangle}
```

Why?

-   It contains all elements from A.
-   It contains all elements from B.
-   It is a subset of any other upper bound.

For sets ordered by inclusion:

\[ LUB(A,B)=A`\cup `{=tex}B \]

The LUB is also called the **join**.

Common notation:

\[ A `\lor `{=tex}B \]

or:

\[ A `\sqcup `{=tex}B \]

## 5.4 Greatest lower bound (GLB) and meet

A **lower bound** L of A and B satisfies:

\[ L `\leq `{=tex}A `\quad `{=tex}`\text{and}`{=tex} `\quad `{=tex}L
`\leq `{=tex}B \]

The **greatest lower bound** is the largest such lower bound. It is also
called the **meet**.

For sets ordered by inclusion:

\[ GLB(A,B)=A`\cap `{=tex}B \]

Example:

``` text
A = {Circle, Rectangle}
B = {Circle, Triangle}

A ∩ B = {Circle}
```

The distinction:

  Concept      Set operation   Meaning
  ------------ --------------- -------------------------------
  Join / LUB   Union           Smallest set containing both
  Meet / GLB   Intersection    Largest set contained in both

## 5.5 Lattice vs join-semilattice

A **lattice** is a partially ordered set in which every pair has both:

-   A least upper bound (join).
-   A greatest lower bound (meet).

A **join-semilattice** only requires every pair to have a least upper
bound.

A **meet-semilattice** only requires every pair to have a greatest lower
bound.

For state-based CRDTs, the important mathematical structure is generally
a **join-semilattice**. A full lattice is not required.

The reason is that the state merge operation uses join (LUB).

# 6. Join, meet, and least upper bound

Use this example to remember the concepts:

``` text
A = {Circle, Rectangle}
B = {Circle, Triangle}
```

Join:

\[ A `\sqcup `{=tex}B = A`\cup `{=tex}B \]

Result:

``` text
{Circle, Rectangle, Triangle}
```

Meet:

\[ A `\sqcap `{=tex}B = A`\cap `{=tex}B \]

Result:

``` text
{Circle}
```

For a state-based CRDT, the merge function is designed to calculate the
join:

\[ merge(A,B)=A`\sqcup `{=tex}B \]

The receiver does not simply overwrite its local state with the incoming
state. It combines both states using the CRDT's merge operation.

# 7. Why merge must be ACI

The merge operation of a join-semilattice has three important algebraic
properties:

-   **A --- Associative**
-   **C --- Commutative**
-   **I --- Idempotent**

Together, these are often abbreviated as **ACI**.

Use set union as the example merge function.

## 7.1 Idempotency

Merging a state with itself does not change it:

\[ A`\sqcup `{=tex}A=A \]

For sets:

``` text
{Circle, Rectangle}
∪
{Circle, Rectangle}

= {Circle, Rectangle}
```

Why useful?

A network may deliver the same state more than once. Repeated merging
does not create extra copies of set elements.

## 7.2 Commutativity

The order of the two inputs does not matter:

\[ A`\sqcup `{=tex}B=B`\sqcup `{=tex}A \]

For sets:

``` text
A = {Circle, Rectangle}
B = {Circle, Triangle}

A ∪ B = B ∪ A
```

Why useful?

Different replicas may receive states in different orders and still
obtain the same merged result.

## 7.3 Associativity

The grouping of merges does not matter:

\[
(A`\sqcup `{=tex}B)`\sqcup `{=tex}C=A`\sqcup`{=tex}(B`\sqcup `{=tex}C)
\]

For sets:

``` text
A = {Circle}
B = {Rectangle}
C = {Triangle}
```

Both groupings produce:

``` text
{Circle, Rectangle, Triangle}
```

Why useful?

Replicas may merge updates at different times or in different groupings.

## 7.4 Summary of ACI

  ---------------------------------------------------------------------------------------------
  Property                Equation                                      Protects against
  ----------------------- --------------------------------------------- -----------------------
  Idempotency             `merge(A,A) = A`                              Duplicate state
                                                                        delivery

  Commutativity           `merge(A,B) = merge(B,A)`                     Different arrival
                                                                        orders

  Associativity           `merge(merge(A,B),C) = merge(A,merge(B,C))`   Different grouping of
                                                                        merges
  ---------------------------------------------------------------------------------------------

These properties make the join operation robust to common network
delivery variations.

# 8. Inflationary (monotonic) updates

A state-based CRDT's local updates must be **inflationary** with respect
to its partial order.

If S is the old state and S' is the updated state:

\[ S`\leq `{=tex}S' \]

This means the update moves the state upwards in the partial order.

For a grow-only set:

``` text
Old state: {Circle}

New state: {Circle, Rectangle}
```

Because:

\[ {Circle}`\subseteq`{=tex}{Circle,Rectangle} \]

the update is inflationary.

Another update:

``` text
{Circle, Rectangle}
→
{Circle, Rectangle, Triangle}
```

is also inflationary.

### Important clarification

"Inflationary" does not necessarily mean a number must become larger.

It means the state moves upwards according to the CRDT's defined partial
order.

For a grow-only set, the order is subset inclusion. For a G-Counter, the
order is component-wise numeric comparison.

A plain integer with `increment` and a `max` merge is **not** enough to
implement a correct distributed increment counter. The G-Counter example
below explains why.

# 9. A complete CvRDT example: G-Counter

A **G-Counter** is a grow-only distributed counter.

It allows multiple replicas to increment a shared logical counter
without losing concurrent increments.

## 9.1 Why a plain integer is insufficient

Suppose two replicas begin at:

``` text
Replica A = 0
Replica B = 0
```

Each independently increments once:

``` text
Replica A = 1
Replica B = 1
```

If the merge is simply maximum:

\[ max(1,1)=1 \]

But two increments happened, so the expected total is 2.

A plain integer does not preserve enough information to distinguish the
two independent increments.

## 9.2 G-Counter solution

Each replica maintains a component of a vector.

For two replicas:

``` text
Replica A state = [0, 0]
Replica B state = [0, 0]
```

Suppose:

-   Component 1 belongs to A.
-   Component 2 belongs to B.

When A increments, it increments only its own component:

``` text
A = [1, 0]
```

When B increments, it increments only its own component:

``` text
B = [0, 1]
```

## 9.3 Merge

The merge function takes the component-wise maximum:

\[ merge(A,B)= \[`\max`{=tex}(A_1,B_1),`\max`{=tex}(A_2,B_2)\] \]

Therefore:

``` text
merge([1,0], [0,1])

= [max(1,0), max(0,1)]

= [1,1]
```

The logical counter value is the sum of the components:

\[ Counter=1+1=2 \]

Both replicas can now store:

``` text
[1, 1]
```

and report the counter value as 2.

## 9.4 Why is this a join-semilattice?

The state is a vector of non-negative integers.

Define the partial order component-wise:

\[ \[a_1,a_2\]`\leq[b_1,b_2]`{=tex}\]

if and only if:

\[ a_1`\leq `{=tex}b_1 `\quad `{=tex}`\text{and}`{=tex}
`\quad `{=tex}a_2`\leq `{=tex}b_2 \]

The join is component-wise maximum.

This merge is:

-   Idempotent.
-   Commutative.
-   Associative.

Each replica's local increment only increases its own component, so
updates are inflationary.

**Result:** The G-Counter is a state-based CRDT (CvRDT).

# 10. Operation-based CRDTs --- CmRDTs

## 10.1 Basic idea

In an operation-based CRDT, a replica does not normally send its entire
state to another replica.

Instead, it communicates the **update operation** that was performed.

The receiving replica applies that operation to its own local state.

Example:

User A adds a circle:

``` js
{
  type: "ADD_SHAPE",
  id: "circle-1",
  x: 100,
  y: 100
}
```

Rather than transmitting the complete whiteboard, A sends this
operation.

The receiver executes the operation locally.

``` text
Replica A: {Circle}
Replica B: {Circle}
```

This can save communication when the full state is large and updates are
small.

## 10.2 Why operation order becomes important

Suppose the initial counter is 0.

Two operations are generated:

``` text
u1 = increment by 1
u2 = increment by 2
```

Replica B receives:

``` text
u1 → u2
```

Its result:

``` text
0 + 1 + 2 = 3
```

Replica C receives:

``` text
u2 → u1
```

Its result:

``` text
0 + 2 + 1 = 3
```

Both replicas converge because addition is commutative.

## 10.3 Commutativity

Two operations commute if applying them in either order produces the
same result.

For operations u1 and u2 on state S:

\[ u_1(u_2(S))=u_2(u_1(S)) \]

Example:

``` text
Initial counter = 0

u1: Add 1
u2: Add 2
```

Then:

\[ (0+1)+2=(0+2)+1=3 \]

The order does not matter.

## 10.4 What if operations do not commute?

Consider:

``` text
Initial value = 10

u1: Multiply by 2
u2: Add 5
```

Order 1:

``` text
10 × 2 = 20
20 + 5 = 25
```

Order 2:

``` text
10 + 5 = 15
15 × 2 = 30
```

Therefore:

\[ (10`\times2`{=tex})+5`\neq`{=tex}(10+5)`\times2`{=tex} \]

The operations are not commutative.

If two replicas apply these concurrent operations in different orders,
they may end with different states.

A CmRDT cannot simply allow arbitrary ordering of these concurrent
operations and still guarantee convergence.

It needs an appropriate CRDT operation design or a stronger ordering
mechanism.

# 11. Commutativity and operation ordering

The important requirement for CmRDTs is:

**Concurrent operations must commute.**

However, not every pair of operations must be treated as concurrent.

Some operations are causally related.

That leads to causal ordering.

A common operation-based CRDT model assumes:

1.  Reliable delivery of operations to the relevant replicas.
2.  Causal delivery: causally dependent operations are delivered in
    causal order.
3.  Concurrent operations commute.

Some systems also use unique operation identifiers and duplicate
suppression, depending on their transport and delivery guarantees.

## 11.1 Concurrent operations

Two operations are concurrent if neither causally happened before the
other.

Example:

-   User A creates a rectangle.
-   User B independently creates a circle.
-   Neither user has seen the other's operation.

If the operations are designed to commute, they can be applied in either
order.

## 11.2 Causally related operations

An operation is causally related to another when it depends on
information produced by the earlier operation.

Example:

``` text
Operation 1: Create rectangle-1
Operation 2: Change rectangle-1 colour to red
```

Operation 2 depends on Operation 1 because the rectangle must exist
before its colour can be changed.

The required order is:

``` text
CREATE → UPDATE_COLOR
```

The reverse order may fail:

``` text
UPDATE_COLOR → CREATE
```

The receiving replica might try to update an object that does not exist
yet.

Therefore, causally dependent operations must be delivered and applied
in causal order.

# 12. Causal ordering

## 12.1 Definition

**Causal ordering means that if operation B causally depends on
operation A, every relevant replica must process A before B.**

In simple terms:

> An event that causes another event must be processed before the event
> it caused.

## 12.2 Whiteboard example

Initially:

``` text
Whiteboard = []
```

User A creates a rectangle:

``` js
{
  type: "CREATE",
  id: "rectangle-1",
  x: 100,
  y: 100
}
```

User B receives the creation and changes its colour:

``` js
{
  type: "UPDATE_COLOR",
  id: "rectangle-1",
  color: "red"
}
```

The causal relationship is:

``` text
CREATE rectangle-1
        |
        v
UPDATE_COLOR rectangle-1
```

The update cannot be correctly applied before the creation.

## 12.3 What if delivery is reversed?

Incorrect delivery:

``` text
UPDATE_COLOR → CREATE
```

The replica tries to find `rectangle-1`, but it does not exist yet.

Depending on the implementation, the update may fail, be ignored, or
need to be buffered until its dependency arrives.

Correct delivery:

``` text
CREATE → UPDATE_COLOR
```

The rectangle exists before the colour update is applied.

## 12.4 Independent operations can arrive in either order

Suppose:

``` text
Operation A: Create rectangle
Operation B: Create circle
```

Neither depends on the other.

The following orders are both valid:

``` text
Rectangle → Circle
```

``` text
Circle → Rectangle
```

If the operations commute, both produce equivalent logical states.

## 12.5 Causal vs concurrent

  -----------------------------------------------------------------------
  Causal operations                   Concurrent operations
  ----------------------------------- -----------------------------------
  One operation depends on another    Neither operation depends on the
                                      other

  Must respect causal order           Can be delivered in either order if
                                      they commute

  Example: Create shape → Change its  Example: Create rectangle and
  colour                              independently create circle
  -----------------------------------------------------------------------

## 12.6 How can a system track causality?

Common techniques include:

-   Lamport timestamps.
-   Vector clocks.
-   Version vectors.
-   Dependency metadata.
-   Causal broadcast protocols.

Example of an operation with dependency metadata:

``` js
{
  id: "operation-102",
  type: "UPDATE_COLOR",
  objectId: "rectangle-1",
  color: "red",
  dependencies: ["operation-101"]
}
```

This indicates that operation-101 must be processed before
operation-102.

This is an illustrative representation. Actual CRDT libraries use their
own metadata and causal tracking mechanisms.

# 13. Delta-state CRDTs --- an efficient form of state-based replication

## 13.1 Why were delta-state CRDTs introduced?

A basic state-based CRDT (CvRDT) communicates its current state. This is
robust because the receiver merges the incoming state with its local
state using a join operation. However, repeatedly transmitting a large
state can waste bandwidth when only a small part has changed.

An operation-based CRDT (CmRDT) can communicate a compact update
operation instead of the full state. Its usual model, however, relies on
appropriate operation delivery guarantees. In particular, causally
dependent operations must be delivered in causal order, and the delivery
assumptions must be satisfied by the communication layer.

Delta-state CRDTs address the state-size problem by allowing a replica
to communicate a **delta**: a small piece of state that represents some
new information. The receiver incorporates that delta using the same
join/merge operation used by a state-based CRDT.

## 13.2 Is a delta-state CRDT a mixture of CvRDT and CmRDT?

It is useful to think of delta-state CRDTs as combining two *ideas*:

- From **CvRDTs**: state-based merging using a join operation. The merge
  remains associative, commutative, and idempotent (ACI), under the
  CRDT's defined state order and merge.
- Similar to **CmRDTs**: communication can be more compact because the
  sender transmits only the information associated with changes, rather
  than repeatedly sending the entire state.

But a delta-state CRDT is **not literally a hybrid of the two CRDT
families**. It remains state-based: the transmitted delta is a partial
state, not necessarily an instruction that the receiver executes.

Compare the messages:

- **CvRDT:** "Here is my current state."
- **CmRDT:** "Execute this operation."
- **Delta-state CRDT:** "Here is a small state fragment representing
  information added by my update; merge it into your state."

This is the most important distinction to remember.

## 13.3 Analogy: a notebook

Imagine that every collaborator has a copy of the same notebook.

- A CvRDT collaborator sends the **entire notebook** to another person.
- A CmRDT collaborator sends an **instruction**, such as "write the
  word CIRCLE on page one."
- A delta-state CRDT collaborator sends a **small piece of notebook
  content** containing the new information, which the receiver merges
  into their own notebook.

The delta is not merely a command. It is state information that can be
joined with the receiver's existing state.

## 13.4 G-Counter example

A G-Counter stores a map from replica identifiers to monotonically
increasing counts. Its merge operation takes the component-wise maximum.

Suppose Alice and Bob begin with:

```js
{
  Alice: 0,
  Bob: 0
}
```

Alice increments her own component. Her state becomes:

```js
{
  Alice: 1,
  Bob: 0
}
```

A full-state exchange could send both components. A delta-state update
can send only the changed component:

```js
{
  Alice: 1
}
```

Bob merges the delta using component-wise maximum:

```js
{
  Alice: Math.max(0, 1),
  Bob: Math.max(0, 0)
}
```

The result is:

```js
{
  Alice: 1,
  Bob: 0
}
```

The receiver is merging state information, not executing an
`INCREMENT(Alice)` command. This example illustrates the difference
between a delta and an operation.

## 13.5 What if messages are duplicated or reordered?

Because deltas are merged using the CRDT's join operation, the ACI
properties are useful:

- **Idempotency:** merging the same delta again does not add its effect a
  second time.
- **Commutativity:** valid deltas can be merged in different orders
  without changing the final join result.
- **Associativity:** deltas can be grouped or accumulated before merging.

These properties make delta-state replication tolerant of duplicate
messages and reordering, provided the deltas are valid for the CRDT and
all required information is eventually disseminated.

## 13.6 What if a replica goes offline?

Suppose Bob disconnects while Alice makes many changes. When Bob
reconnects, the system can use one of several recovery strategies:

1. Retain and send the deltas Bob has missed.
2. Accumulate multiple deltas into a larger delta when the CRDT supports
   that operation.
3. Send a full state snapshot if retaining or reconstructing the missed
   deltas is impractical.

Delta-state CRDTs do **not** automatically remove the need for recovery
or guarantee that no history is ever needed. They provide a way to send
compact state changes; the application still needs a synchronization
and recovery strategy.

## 13.7 Delta versus operation: side-by-side

| Aspect | Operation-based update | Delta-state update |
|---|---|---|
| Message meaning | An instruction/event to apply | A partial state containing information |
| Receiver | Delivers and executes the operation | Merges the delta with local state |
| Main correctness idea | Concurrent operations commute; causal dependencies are respected | Join-based state merge with ACI properties |
| Example | `INCREMENT(Alice)` | `{ Alice: 1 }` |

The exact delta representation depends on the CRDT. A delta is not
always simply the changed fields of an ordinary JavaScript object; it
must be constructed so that merging it is mathematically valid.

## 13.8 NetWrite 2.0 application

For a collaborative whiteboard, imagine Alice adds a shape. A delta-state
approach could communicate a compact state fragment containing the new
shape's CRDT information. The server or another client merges that
fragment into its local replica and can then disseminate it onward.

Keep these responsibilities separate:

- **CRDT data type:** Defines how concurrent changes are represented and
  merged.
- **Delta generation:** Produces compact state fragments to communicate.
- **WebSocket or other transport:** Carries messages between participants.
- **Persistence:** Stores state and/or synchronization information for
  recovery.
- **Synchronization protocol:** Determines which deltas a replica has
  missed and how it catches up.

WebSocket provides ordered messages on an individual connection, but it
does not by itself guarantee causal ordering across multiple clients,
connections, servers, or application-level asynchronous processing.
The CRDT's mathematical properties and the synchronization protocol
remain important.

## 13.9 Main takeaway

A delta-state CRDT is best described as an **optimized state-based
CRDT**. It preserves join-based state merging while allowing replicas to
transmit smaller state deltas instead of repeatedly transmitting the
entire state. It borrows the bandwidth-efficiency intuition of
operation-based replication, but a delta is state to merge, not
necessarily an operation to execute.

# 14. CvRDT vs CmRDT vs delta-state CRDT

| Feature | CvRDT | CmRDT | Delta-state CRDT |
|---|---|---|---|
| What is sent? | Full state | Operations | Partial state (deltas) |
| What does receiver do? | Merge state | Deliver/apply operation | Merge delta into state |
| Core correctness idea | Join-semilattice and ACI merge | Concurrent operations commute; causal delivery for dependencies | Join-based state merge and ACI properties |
| Typical bandwidth | Can be high for large states | Often low per operation | Often lower than repeatedly sending full state |
| Offline recovery | Exchange current state | Replay retained operations or send snapshot | Send missed/accumulated deltas or a snapshot |
| Is it state-based? | Yes | No; operation-based | Yes |

**Memory aid:** Full notebook = CvRDT; instruction = CmRDT; small
mergeable piece of notebook state = delta-state CRDT.

# 15. CvRDT vs CmRDT

  -----------------------------------------------------------------------
  Feature                 CvRDT                   CmRDT
  ----------------------- ----------------------- -----------------------
  Full name               Convergent Replicated   Commutative Replicated
                          Data Type               Data Type

  Communication           State exchange          Operation exchange

  What is sent?           Full state, or state    Update operations
                          deltas in delta-state   
                          variants                

  Receiver behavior       Merge received state    Apply delivered
                          with local state        operation

  Main mathematical       Join-semilattice        Concurrent operations
  requirement                                     commute

  Important properties    Merge is associative,   Causal delivery and
                          commutative,            reliable operation
                          idempotent; updates are dissemination are
                          inflationary            common assumptions

  Typical concern         State size and merge    Operation delivery,
                          cost                    ordering, and duplicate
                                                  handling
  -----------------------------------------------------------------------

## 15.1 Easy way to remember

**CvRDT:**

"Here is my state. Merge it with yours."

**CmRDT:**

"Here is the operation I performed. Apply it to yours."

# 16. Replication topologies: star, mesh, and gossip

CRDT theory does not prescribe a particular network topology.

The topology describes how replicas communicate, not how their data
structures merge.

## 14.1 Star topology

All clients communicate through a central server.

``` text
             Relay Server
             /    |    \
            /     |     \
           A      B      C
```

The server can:

-   Forward updates.
-   Store a replica.
-   Persist snapshots.
-   Help with discovery and access control.

The server does not have to be the exclusive authority for every edit.

Advantages:

-   Easier to implement.
-   Easier authentication and connection management.
-   Works naturally with a Socket.IO backend.

Disadvantages:

-   Server can become a bottleneck.
-   Communication depends on server availability.

## 14.2 Full mesh topology

Every replica can communicate directly with every other replica.

``` text
        A
       / \
      /   \
     B-----C
```

For n replicas, the number of possible pairwise connections is:

\[ E=`\frac{n(n-1)}{2}`{=tex} \]

Examples:

    Replicas   Pairwise connections
  ---------- ----------------------
           2                      1
           3                      3
           5                     10
          10                     45
         100                  4,950

Advantages:

-   Direct peer communication.
-   No central relay is required for synchronization.
-   Can support decentralized collaboration.

Disadvantages:

-   Connection count grows quickly.
-   Peer discovery and reconnection are harder.
-   Network traffic can become expensive.

## 14.3 Gossip / anti-entropy

A replica periodically exchanges information with selected peers.

A state-based replica might send its state to a peer, which merges it
and later propagates the combined state to another peer.

This allows information to spread through the network without every
replica directly contacting every other replica.

Gossip is a dissemination strategy, not a separate CRDT family.

## 14.4 Important distinction

Keep these decisions separate:

  Decision           Question answered
  ------------------ ----------------------------------------
  CRDT type          How are concurrent changes reconciled?
  Network topology   How do replicas communicate?
  Persistence        Where is data stored durably?
  Transport          How are messages sent?

A CvRDT can use star, mesh, or gossip. A CmRDT can also use different
communication topologies, provided its delivery assumptions are
satisfied.

# 17. CRDTs in a collaborative whiteboard

Consider a whiteboard with multiple users.

Potential operations include:

``` text
CREATE_SHAPE
MOVE_SHAPE
RESIZE_SHAPE
CHANGE_COLOR
DELETE_SHAPE
ADD_STROKE
```

Not every operation automatically forms a valid CRDT operation.

The data type must define what happens when concurrent operations affect
the same object.

## 15.1 Independent additions

User A creates a rectangle:

``` js
{
  type: "ADD_SHAPE",
  id: "shape-1",
  shape: "rectangle",
  x: 100,
  y: 100
}
```

User B creates a circle:

``` js
{
  type: "ADD_SHAPE",
  id: "shape-2",
  shape: "circle",
  x: 300,
  y: 200
}
```

If shapes are stored by unique IDs and the add semantics are designed
correctly, these independent additions can commute.

The resulting logical state contains both shapes.

## 15.2 Concurrent edits to the same shape

Suppose a rectangle initially has:

``` text
Position = (100, 100)
Colour = blue
```

User A moves it.

User B changes its colour.

These operations affect different properties and may be designed to
commute.

But suppose both users move the same rectangle to different absolute
positions.

``` text
A: Set position to (200, 100)
B: Set position to (100, 200)
```

These are competing updates to the same property.

The application must define a conflict-resolution policy or use a CRDT
data type with appropriate semantics.

Possible designs include:

-   A deterministic last-writer-wins register.
-   A multi-value register that preserves concurrent values.
-   A relative movement operation, if additive movement matches the
    desired behavior.
-   A sequence or object-specific CRDT with custom rules.

There is no universal rule that automatically makes every whiteboard
operation conflict-free.

## 15.3 Deletion is not simply removing an element

For a grow-only set, union works because elements are only added.

But consider:

``` text
Replica A: {Circle, Rectangle}
Replica B: {Circle}
```

If B deleted Rectangle, simply merging with set union would reintroduce
Rectangle:

``` text
{Circle, Rectangle} ∪ {Circle}
= {Circle, Rectangle}
```

This demonstrates why deletion requires additional metadata or a
different CRDT design.

Examples of CRDT structures that handle removal include:

-   Two-Phase Set (2P-Set).
-   Observed-Remove Set (OR-Set).
-   Other add/remove set designs.

These are useful topics to study after the basic models.

# 18. Important corrections and common misconceptions

## Misconception 1: A CRDT never uses a server

Incorrect.

A CRDT does not require a central authoritative server for conflict
resolution, but a server may still:

-   Relay messages.
-   Store a replica.
-   Persist snapshots.
-   Handle authentication.
-   Manage rooms and membership.

## Misconception 2: A replica is a user

Incorrect.

A replica is a copy of shared state. A browser, server process, or
device can maintain one.

## Misconception 3: CvRDT always sends the full state

Traditional state-based replication exchanges states. However,
delta-state CRDTs can exchange smaller state deltas while retaining
state-based merge semantics.

## Misconception 4: CmRDT can apply all operations in any order

Incorrect.

Concurrent operations must commute. Causally dependent operations must
respect causal ordering.

## Misconception 5: Commutativity alone handles lost or duplicated messages

Incorrect.

The communication model matters. CmRDTs commonly assume reliable causal
delivery. Implementations must handle duplicates according to their
delivery protocol and operation semantics.

## Misconception 6: Any set can be merged using union, including deletion

Incorrect.

Ordinary set union gives grow-only behavior. Correct removal needs a
more sophisticated data type and metadata.

## Misconception 7: Every pair of operations must commute

Not necessarily.

The key condition concerns concurrent operations. Causally related
operations are delivered in causal order.

## Misconception 8: CRDT means users can never disagree about application behavior

Incorrect.

CRDTs provide convergence guarantees for a defined data type. The
application still needs to choose meaningful conflict semantics.

# 19. Worked examples

## Example 1: Find the LUB of two sets

Given:

``` text
A = {A, B}
B = {B, C}
```

The ordering is subset inclusion.

The least upper bound is the union:

``` text
A ∪ B = {A, B, C}
```

Answer:

``` text
LUB(A, B) = {A, B, C}
```

## Example 2: Check whether merge is idempotent

Given:

``` text
merge(A, B) = A ∪ B
A = {1, 2}
```

Calculate:

``` text
merge(A, A)
= {1, 2} ∪ {1, 2}
= {1, 2}
= A
```

Therefore, it is idempotent.

## Example 3: Check commutativity

Given:

``` text
A = {1, 2}
B = {2, 3}
```

Calculate:

``` text
A ∪ B = {1, 2, 3}
B ∪ A = {1, 2, 3}
```

Therefore, union is commutative.

## Example 4: Check associativity

Given:

``` text
A = {1}
B = {2}
C = {3}
```

Calculate:

``` text
(A ∪ B) ∪ C
= {1, 2} ∪ {3}
= {1, 2, 3}
```

And:

``` text
A ∪ (B ∪ C)
= {1} ∪ {2, 3}
= {1, 2, 3}
```

Therefore, union is associative.

## Example 5: Check whether operations commute

Initial value:

``` text
x = 10
```

Operations:

``` text
u1: Add 5
u2: Multiply by 2
```

Order 1:

``` text
(10 + 5) × 2 = 30
```

Order 2:

``` text
(10 × 2) + 5 = 25
```

Since 30 is not equal to 25, these operations do not commute.

## Example 6: Identify causal ordering

Events:

1.  Create a rectangle.
2.  Change its colour.
3.  Independently create a circle.

Relationships:

``` text
CREATE RECTANGLE
       |
       v
CHANGE COLOUR

CREATE CIRCLE
```

The colour update depends on rectangle creation. Circle creation is
independent.

Therefore:

-   Rectangle creation must precede the colour update.
-   Circle creation can occur independently.

# 20. Revision questions

Try answering these without looking at the explanations.

## A. Conceptual questions

1.  What is a replica?
2.  Why do distributed applications maintain replicas?
3.  What is the difference between state and an operation?
4.  What is a CRDT?
5.  What is the difference between CvRDT and CmRDT?
6.  Does a CRDT require a central server?
7.  Can a server maintain a replica?
8.  Does the CRDT model determine the network topology?

## B. Mathematical questions

9.  What is a partially ordered set?
10. State the three properties of a partial order.
11. What is an upper bound?
12. What is a least upper bound?
13. What is a greatest lower bound?
14. What is a lattice?
15. What is a join-semilattice?
16. Why do state-based CRDTs use join?
17. What do idempotency, commutativity, and associativity mean?
18. What is an inflationary update?

## C. CvRDT questions

19. What does a replica send in a state-based CRDT?
20. What does the receiving replica do?
21. Why must the merge function be ACI?
22. Why is a plain integer with max-merge insufficient for a distributed
    increment counter?
23. How does a G-Counter solve that problem?
24. Why is a G-Counter a join-semilattice?

## D. CmRDT questions

25. What does a replica send in an operation-based CRDT?
26. Why must concurrent operations commute?
27. What happens when two concurrent operations are non-commutative?
28. Does operation-based replication require causal ordering?
29. Why does reliable delivery matter?
30. How is operation-based replication different from state-based
    replication?

## E. Causal ordering questions

31. What is causal ordering?
32. Give an example of two causally related operations.
33. Give an example of two concurrent operations.
34. Why must a creation operation precede an update to the created
    object?
35. What are Lamport timestamps and vector clocks used for?

## F. Delta-state CRDT questions

41. What is a delta-state CRDT?
42. Why is it still considered state-based?
43. How is a delta different from an operation?
44. How can ACI merge properties help when deltas are duplicated or reordered?
45. How might an offline replica catch up after missing deltas?

## G. Application questions

36. How would you handle two users independently creating shapes?
37. What happens if two users move the same shape to different absolute
    positions?
38. Why can't ordinary set union handle deletion?
39. What is the difference between star and mesh topology?
40. What is the purpose of gossip synchronization?

# 21. Glossary

  -----------------------------------------------------------------------
  Term                                Definition
  ----------------------------------- -----------------------------------
  CRDT                                Conflict-free Replicated Data Type

  Replica                             An independently maintained copy of
                                      shared data

  State                               Current data representing an object

  Operation                           A change applied to a state

  Synchronization                     Communication and incorporation of
                                      changes

  Convergence                         Replicas eventually reach
                                      equivalent states

  CvRDT                               Convergent, state-based replicated
                                      data type

  CmRDT                               Commutative, operation-based
                                      replicated data type

  Poset                               Partially ordered set

  Upper bound                         An element greater than or equal to
                                      the compared elements

  LUB                                 Least upper bound

  GLB                                 Greatest lower bound

  Join                                LUB operation

  Meet                                GLB operation

  Lattice                             Poset in which every pair has a
                                      join and a meet

  Join-semilattice                    Poset in which every pair has a
                                      join

  Idempotency                         Repeating an operation has no
                                      additional effect

  Commutativity                       Changing operation order does not
                                      change the result

  Associativity                       Changing grouping does not change
                                      the result

  Inflationary update                 An update that moves state upwards
                                      in the partial order

  Causal ordering                     Respecting dependencies between
                                      operations

  Concurrent operations               Operations with no causal ordering
                                      between them

  Gossip                              A strategy for spreading
                                      information among replicas

  Anti-entropy                        A synchronization process that
                                      repairs differences between
                                      replicas

  Delta-state CRDT                    A state-based CRDT that communicates
                                      partial states (deltas) and merges
                                      them using join
  -----------------------------------------------------------------------

------------------------------------------------------------------------

# Final Cheat Sheet

## CvRDT

``` text
Replica A                    Replica B
    |                            |
    |------ Send state --------->|
    |                            |
    |                    Merge with local state
    |                            |
    |<------ Send state ---------|
    |                            |
 Merge with local state          |
```

Remember:

-   Exchange states.
-   Merge using Join / LUB.
-   State space forms a join-semilattice.
-   Updates are inflationary.
-   Merge is associative, commutative, and idempotent.
-   Eventual dissemination leads to convergence.

## CmRDT

``` text
Replica A                    Replica B
    |                            |
    |--- Send operation -------->|
    |                            |
    |                     Apply operation
    |                            |
```

Remember:

-   Exchange operations.
-   Apply received operations.
-   Concurrent operations must commute.
-   Causally dependent operations must be delivered in causal order.
-   Reliable operation dissemination is required by the usual model.

## The three most important distinctions

1.  **CvRDT vs CmRDT:** State exchange versus operation exchange.
2.  **Causal vs concurrent:** Dependent operations versus independent
    operations.
3.  **CRDT vs topology:** Data consistency rules versus communication
    architecture.

**One final takeaway:**

CRDTs are not primarily about how messages travel across a network. They
are about designing replicated data structures whose mathematical
properties allow independently updated replicas to converge correctly
when they synchronize.

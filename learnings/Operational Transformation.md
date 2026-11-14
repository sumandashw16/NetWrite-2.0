# Operational Transformation (OT)

## A Detailed Guide to Collaborative Systems

## 1. Introduction

**Operational Transformation (OT)** is a technique used in collaborative applications to handle simultaneous modifications made by multiple users to shared data.

It allows multiple users to edit the same document or shared resource concurrently while maintaining consistency across all connected clients.

### Applications of OT

- Google Docs – Multiple users editing the same document.
- Collaborative text editors.
- Collaborative code editors.
- Shared documents and spreadsheets.
- Real-time collaborative applications.

### The Problem OT Solves: Concurrency

Consider two users editing the same document.

Initial document:

```text
HELLO
```

User A inserts `X` at position 0:

```js
insert(0, "X");
```

User B inserts `Y` at position 0:

```js
insert(0, "Y");
```

Suppose both operations are executed independently.

**User A's perspective:**

1. Starts with `HELLO`.
2. Inserts X → `XHELLO`.
3. Receives User B's operation.
4. Inserts Y at position 0 → `YXHELLO`.

**User B's perspective:**

1. Starts with `HELLO`.
2. Inserts Y → `YHELLO`.
3. Receives User A's operation.
4. Inserts X at position 0 → `XYHELLO`.

The final documents are different:

```text
User A: YXHELLO
User B: XYHELLO
```

This is a consistency problem.

Both users performed valid operations, but applying them in different orders resulted in different states.

OT addresses this problem by transforming operations before applying them to an updated document.

---

## 2. Fundamental Idea Behind OT

The fundamental idea of Operational Transformation is:

**When an operation arrives, transform it according to the operations that have already been applied to the shared document.**

Instead of blindly executing an outdated operation, OT adjusts it so that it remains meaningful in the current document state.

### Example

Initial document:

```text
HELLO
```

User A:

```js
insert(0, "X");
```

User B:

```js
insert(0, "Y");
```

Assume User A's operation is applied first.

The document becomes:

```text
XHELLO
```

Now User B's original operation is no longer directly applicable at the same position if we want to preserve the chosen insertion ordering.

Original operation:

```js
insert(0, "Y");
```

Transformed operation:

```js
insert(1, "Y");
```

Final document:

```text
XYHELLO
```

Both users can now converge to the same result.

This adjustment is called **Operational Transformation**.

---

## 3. Understanding Operations

An operation is an instruction that modifies a shared document.

For a basic text editor, three fundamental operation types are:

1. Insert
2. Delete
3. Retain

### 3.1 Insert Operation

An insert operation adds content at a particular position.

Example:

```js
{
    type: "insert",
    position: 2,
    text: "X"
}
```

Initial document:

```text
HELLO
```

Character positions:

```text
 H  E  L  L  O
 0  1  2  3  4
```

Insert X at position 2:

```text
HEXLLO
```

Position 2 refers to the location immediately before the third character.

### 3.2 Delete Operation

A delete operation removes content from a specified position.

Example:

```js
{
    type: "delete",
    position: 2,
    length: 1
}
```

Initial document:

```text
HELLO
```

Delete the character at position 2:

```text
HELO
```

### 3.3 Retain Operation

A retain operation specifies how much existing content should remain unchanged.

Example:

```js
[
    { type: "retain", count: 2 },
    { type: "insert", text: "X" },
    { type: "retain", count: 3 }
]
```

Initial document:

```text
HELLO
```

Interpretation:

1. Retain the first two characters: HE.
2. Insert X.
3. Retain the next three characters: LLO.

Final document:

```text
HEXLLO
```

Retain is especially useful when representing complex text edits as a sequence of operations.

---

## 4. Transformation Rules

The most important part of OT is understanding how concurrent operations interact.

The three fundamental combinations are:

1. Insert vs Insert
2. Insert vs Delete
3. Delete vs Delete

### 4.1 Insert vs Insert

Consider the initial document:

```text
ABCDE
```

User A:

```js
insert(2, "X");
```

User B:

```js
insert(2, "Y");
```

Both users want to insert at position 2.

Assume User A's operation is applied first.

The document becomes:

```text
ABXCDE
```

Since X was inserted at position 2, the original content after that position shifts right.

Therefore, User B's insertion must be transformed.

Original:

```js
insert(2, "Y");
```

Transformed:

```js
insert(3, "Y");
```

Final document:

```text
ABXYCDE
```

**Transformation rule:**

When an insertion occurs before or at the same position as another insertion, the second insertion's position must be adjusted.

For a one-character insertion:

\[
p'_B =
\begin{cases}
p_B+1 & p_A \leq p_B\\
p_B & p_A > p_B
\end{cases}
\]

Where:

- \(p_A\): Position of operation A.
- \(p_B\): Original position of operation B.
- \(p'_B\): Transformed position of B.

For simultaneous insertions at the same position, a deterministic tie-breaking rule is required.

For example, clients can use operation IDs or a predefined priority to determine insertion order.

### 4.2 Insert vs Delete

Consider:

```text
ABCDE
```

User A inserts X at position 2:

```js
insert(2, "X");
```

User B deletes one character at position 3:

```js
delete(3, 1);
```

Assume A's operation is applied first.

The document becomes:

```text
ABXCDE
```

Originally, User B wanted to delete D.

After inserting X, D moves from position 3 to position 4.

Therefore, B's operation becomes:

```js
delete(4, 1);
```

Final document:

```text
ABXCE
```

**Rule:**

If an insertion occurs before the deletion position, the deletion position shifts forward by the inserted length.

\[
p'_D =
\begin{cases}
p_D+L_I & p_I \leq p_D\\
p_D & p_I > p_D
\end{cases}
\]

Where:

- \(p_D\): Original deletion position.
- \(p_I\): Insertion position.
- \(L_I\): Inserted content length.

#### Reverse Situation: Delete vs Insert

Initial document:

```text
ABCDE
```

User A:

```js
delete(1, 1);
```

User B:

```js
insert(3, "X");
```

A deletes B:

```text
ACDE
```

The original insertion position 3 now needs to shift left by one.

Transformed operation:

```js
insert(2, "X");
```

Final document:

```text
ACXDE
```

**Rule:**

If a deletion occurs before an insertion position, shift the insertion position backward by the deleted length.

### 4.3 Delete vs Delete

Consider:

```text
ABCDE
```

User A:

```js
delete(1, 2);
```

User B:

```js
delete(2, 2);
```

User A wants to delete B and C.

User B wants to delete C and D.

Assume A's operation is applied first.

Original:

```text
ABCDE
```

After A deletes B and C:

```text
ADE
```

User B's original deletion targeted C and D.

However, C has already been deleted.

Only D remains.

Therefore, B's transformed operation becomes:

```js
delete(1, 1);
```

Final document:

```text
AE
```

**Rule:**

When two deletion ranges overlap, the overlapping section should not be deleted twice.

The transformed operation must account for:

- The portion already deleted.
- The remaining portion that still needs deletion.
- The new position of the remaining content.

---

## 5. Transformation Function

A transformation function takes two concurrent operations and produces a modified version of one of them.

It can be represented as:

\[
T(O_A,O_B)=O'_B
\]

Where:

- \(O_A\): Operation already applied.
- \(O_B\): Operation created against the previous document state.
- \(O'_B\): Transformed operation that can be applied after A.

Example:

```js
const A = {
    type: "insert",
    position: 2,
    text: "X"
};

const B = {
    type: "insert",
    position: 2,
    text: "Y"
};

const BPrime = transform(A, B);
```

Result:

```js
{
    type: "insert",
    position: 3,
    text: "Y"
}
```

The transformation function considers the relationship between the operations and adjusts the incoming operation accordingly.

---

## 6. Important Properties of OT

Two fundamental concepts are:

1. Convergence
2. Intention Preservation

### 6.1 Convergence

Convergence means that all clients should eventually reach the same final document, regardless of the order in which concurrent operations are received.

For two concurrent operations A and B, a common formulation of the convergence property is:

\[
Apply(Apply(D,A),T(A,B))
\]

must equal:

\[
Apply(Apply(D,B),T(B,A))
\]

In simple words:

- Apply A, then transformed B.
- Apply B, then transformed A.

Both should produce the same final document.

This is a fundamental correctness requirement of OT.

### 6.2 Intention Preservation

Intention preservation means that the original intention of an operation should be maintained as much as possible after transformation.

Example:

Initial document:

```text
HELLO WORLD
```

User A inserts:

```js
insert(0, "MY ");
```

User B deletes:

```js
delete(6, 5);
```

User B intended to delete WORLD.

Since User A inserted three characters before the deletion range, B's deletion must shift accordingly.

Transformed operation:

```js
delete(9, 5);
```

This ensures that the deletion continues to target WORLD rather than deleting unrelated characters.

---

## 7. TP1 and TP2: Formal Transformation Properties

OT systems often use formal correctness properties to ensure that transformations work correctly across multiple concurrent operations.

### TP1: Convergence Property

TP1 ensures that two concurrent operations, when transformed against one another, produce equivalent final document states regardless of application order.

\[
Apply(Apply(D,A),T(A,B))
=
Apply(Apply(D,B),T(B,A))
\]

This ensures that the clients converge.

### TP2: Transformation Consistency

TP2 concerns the consistency of transformations involving multiple concurrent operations.

It ensures that when three concurrent operations are transformed through different valid paths, the resulting transformed operation remains equivalent.

Conceptually:

- Operation A and B are concurrent.
- Operation C is also concurrent with them.
- The transformation order must not produce contradictory results.

A common form of the TP2 condition, using \(T(A,B)\) to mean B transformed against A, is:

\[
T(T(A,B),T(A,C))
=
T(T(B,A),T(B,C))
\]

This is a simplified notation for the consistency condition; exact formulations depend on the OT model and operation representation.

TP1 and TP2 are particularly important when building an OT engine that must handle multiple concurrent operations rather than just two.

---

## 8. Version Numbers and Operation History

In real collaborative applications, operations may arrive late or out of order.

Therefore, OT systems commonly maintain document versions and operation history.

Example operation:

```js
{
    userId: "user-B",

    operation: {
        type: "insert",
        position: 2,
        text: "Y"
    },

    baseVersion: 0
}
```

Suppose the server has already processed three operations and is currently at version 3.

User B's operation was created against version 0.

It is now outdated.

The server needs to transform B against all operations that were applied after version 0.

Conceptually:

\[
B' = T(D,T(C,T(A,B)))
\]

The exact nesting depends on the transformation function's argument convention.

The key idea is that every intervening operation must be accounted for.

### Why Version Numbers Matter

They help the system:

- Detect outdated operations.
- Identify which operations need transformation.
- Maintain a consistent operation history.
- Synchronize clients that have fallen behind.
- Handle reconnections.

---

## 9. OT Architecture in a Client-Server Application

A typical centralized OT architecture works as follows:

1. User A performs an operation.
2. The frontend applies the operation optimistically.
3. The frontend sends the operation to the server.
4. The server checks the operation's base version.
5. The server transforms the operation if necessary.
6. The server applies the transformed operation.
7. The server increments the document version.
8. The server broadcasts the accepted operation.
9. Connected clients update their local documents.

### Simplified Architecture

```text
             USER A
                |
                |
          Creates Operation
                |
                v
        +----------------+
        |                |
        |     SERVER     |
        |                |
        |    OT ENGINE   |
        |                |
        +----------------+
                |
       Transform Operation
                |
         Update Document
                |
         Broadcast Changes
                |
          +-----+-----+
          |           |
          v           v
        USER A      USER B
          |           |
          v           v
       Updated     Updated
       Document    Document
```

The server maintains the authoritative document state and processes operations in a consistent order.

This is a common architecture, although OT can also be implemented in distributed systems.

---

## 10. Simplified JavaScript Implementation

The following example implements only insert-insert transformation.

It is an educational demonstration, not a production-ready OT implementation.

### Apply Function

```js
function applyOperation(document, operation) {

    if (operation.type === "insert") {

        return (
            document.slice(0, operation.position) +
            operation.text +
            document.slice(operation.position)
        );

    }

    return document;
}
```

### Transform Function

```js
function transform(operationA, operationB) {

    if (
        operationA.type === "insert" &&
        operationB.type === "insert"
    ) {

        if (
            operationA.position < operationB.position ||
            (
                operationA.position === operationB.position &&
                operationA.userId < operationB.userId
            )
        ) {

            return {
                ...operationB,

                position:
                    operationB.position +
                    operationA.text.length
            };

        }

    }

    return operationB;
}
```

### Testing

```js
let document = "HELLO";

const A = {
    type: "insert",
    position: 0,
    text: "X",
    userId: "A"
};

const B = {
    type: "insert",
    position: 0,
    text: "Y",
    userId: "B"
};

// Apply A
document = applyOperation(document, A);

// Transform B against A
const BPrime = transform(A, B);

// Apply transformed B
document = applyOperation(document, BPrime);

console.log(document);
```

Output:

```text
XYHELLO
```

A complete implementation would additionally need:

- Delete transformations.
- Retain operations.
- Operation composition.
- Operation versioning.
- Client-side pending operation management.
- Undo and redo.
- Reconnection and synchronization.
- Proper concurrent operation handling.

---

## 11. OT vs CRDT

Another important approach to collaborative synchronization is CRDT.

Both OT and CRDT solve the problem of maintaining consistency across multiple replicas that receive concurrent modifications.

However, their approaches are different.

| Feature | OT | CRDT |
|---|---|---|
| Full form | Operational Transformation | Conflict-free Replicated Data Type |
| Main approach | Transform operations | Use data structures with merge properties |
| Operation history | Often important | Depends on the CRDT design |
| Central server | Common, not mandatory | Not mandatory |
| Offline collaboration | Possible, requires coordination | Often easier to support |
| Complexity | Transformation rules can be difficult | Data structures and metadata can be complex |
| Examples | Google Docs-style systems | Yjs, Automerge |

### OT Approach

OT changes incoming operations based on previously applied operations.

For example:

```text
Insert X at position 2
```

may become:

```text
Insert X at position 3
```

because another operation changed the document first.

### CRDT Approach

CRDTs use carefully designed data structures and unique identifiers so that concurrent changes can be merged consistently.

Rather than relying on the same position-adjustment mechanism as OT, a sequence CRDT may assign stable identifiers to elements.

Concurrent insertions can then coexist and be ordered deterministically.

CRDTs are particularly useful when replicas need to make changes independently and synchronize later.

---

## 12. When Should You Use OT?

OT is useful when:

- Multiple users edit the same document.
- Concurrent operations need to be reconciled.
- A centralized server can coordinate operation processing.
- The application has well-defined transformation rules.
- Users need immediate collaborative editing.

However, OT should not be implemented unnecessarily.

For example, in a collaborative whiteboard:

- Two users drawing independent strokes may not need OT.
- Two users creating different shapes may not need OT.
- Two users editing the same object may need conflict-resolution logic.
- Complex concurrent edits to shared structures may benefit from OT or CRDT.

The correct synchronization model depends on the data structure and operation semantics.

---

## 13. Important Terminology

| Term | Meaning |
|---|---|
| Concurrency | Multiple operations occurring independently at approximately the same time |
| Operation | An instruction that modifies shared data |
| Transformation | Adjusting an operation based on another operation |
| Convergence | All replicas eventually reach the same state |
| Intention Preservation | Maintaining the original intention of an operation |
| TP1 | Transformation convergence property |
| TP2 | Transformation consistency property involving multiple operations |
| Base Version | The document version against which an operation was created |
| Operation History | Previously processed operations used for synchronization |
| Optimistic Update | Applying a local operation before server confirmation |
| Replica | A local copy of shared data maintained by a client |

---

## 14. Final Summary

Operational Transformation is a synchronization technique designed to handle concurrent edits in collaborative applications.

Its central idea is to transform operations so that they remain valid after other concurrent operations have modified the shared document.

The most important concepts are:

1. OT solves concurrency problems.
2. Operations describe modifications to shared data.
3. Insert, Delete, and Retain are fundamental text-editing operations.
4. Insert-Insert, Insert-Delete, and Delete-Delete are important transformation cases.
5. Convergence ensures that all clients eventually reach the same state.
6. Intention Preservation ensures that transformed operations continue to reflect the user's original intent.
7. TP1 and TP2 describe important formal correctness requirements.
8. Version numbers and operation history help manage stale operations.
9. OT and CRDT are different approaches to collaborative synchronization.

**The central takeaway:**

OT modifies operations to account for concurrent changes, allowing multiple users to edit shared data while maintaining consistency.

---

## 15. Further Learning

Recommended topics to study next:

- Transformation functions in greater mathematical detail.
- TP1 and TP2 correctness proofs.
- Operational Transformation algorithms such as Jupiter.
- Centralized vs distributed OT.
- Client-side pending operation management.
- CRDT fundamentals.
- State-based vs operation-based CRDTs.
- Sequence CRDTs.
- Conflict-free replicated registers.
- Yjs and Automerge architectures.

**Next topic: Conflict-free Replicated Data Types (CRDTs).**
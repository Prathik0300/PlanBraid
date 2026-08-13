/**
 * Which dependency edge types participate in the DAG.
 *
 * `dependencies.type` also carries symmetric annotation edges (`relates_to`,
 * `duplicates`, `supersedes`) that describe a relationship without implying order.
 * Treating those as ordering edges is a real bug: `A relates_to B` plus
 * `B relates_to A` is two true, non-contradictory facts, but a cycle check that
 * doesn't filter by type rejects the second edge as a cycle. Every traversal
 * (cycle detection, blocking-count propagation, topological analysis) must filter
 * on this set rather than reading `dependencies` unfiltered.
 */
export const DAG_EDGE_TYPES = ["blocks", "requires"] as const;
export type DagEdgeType = (typeof DAG_EDGE_TYPES)[number];

// `conflicts_with` (M19): mutual exclusion between two competing approaches, raised by a
// human decision. Deliberately not a DAG edge type — it says two things cannot both be
// true, never that one must happen before the other, and putting it in DAG_EDGE_TYPES
// would deadlock both sides' blocking_count against each other for no reason.
//
// `subset_of` / `superset_of` / `overlaps_with` / `follows` (E4,
// RECONCILIATION_ARCHITECTURE.md's Stage 3 relation typing — lib/dedup/relations.ts is
// what produces them): the reconciliation engine's SUBSET, SUPERSET, OVERLAP, and
// SEQUENCE relation types, made queryable graph structure instead of a text note nobody
// but the creating agent ever sees again. `follows` in particular is deliberately an
// annotation, not a DAG edge — it is a heuristic ("add" work is typically followed by
// "test"/"document" work on the same artifact), and heuristically inferring a *hard*
// blocking dependency from an action-verb guess would risk exactly the kind of silent
// mis-ordering this codebase has otherwise refused to accept as a tradeoff.
export const ANNOTATION_EDGE_TYPES = ["relates_to", "duplicates", "supersedes", "conflicts_with", "subset_of", "superset_of", "overlaps_with", "follows"] as const;
export type AnnotationEdgeType = (typeof ANNOTATION_EDGE_TYPES)[number];

export const ALL_EDGE_TYPES = [...DAG_EDGE_TYPES, ...ANNOTATION_EDGE_TYPES] as const;
export type EdgeType = (typeof ALL_EDGE_TYPES)[number];

export function isDagEdgeType(type: string): type is DagEdgeType {
  return (DAG_EDGE_TYPES as readonly string[]).includes(type);
}

/** SQL fragment for an `IN (...)` clause over the DAG edge types. Keep in sync with DAG_EDGE_TYPES's arity. */
export const DAG_EDGE_TYPE_SQL_LIST = DAG_EDGE_TYPES.map(() => "?").join(", ");

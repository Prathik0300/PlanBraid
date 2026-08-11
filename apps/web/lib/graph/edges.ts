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

export const ANNOTATION_EDGE_TYPES = ["relates_to", "duplicates", "supersedes"] as const;
export type AnnotationEdgeType = (typeof ANNOTATION_EDGE_TYPES)[number];

export const ALL_EDGE_TYPES = [...DAG_EDGE_TYPES, ...ANNOTATION_EDGE_TYPES] as const;
export type EdgeType = (typeof ALL_EDGE_TYPES)[number];

export function isDagEdgeType(type: string): type is DagEdgeType {
  return (DAG_EDGE_TYPES as readonly string[]).includes(type);
}

/** SQL fragment for an `IN (...)` clause over the DAG edge types. Keep in sync with DAG_EDGE_TYPES's arity. */
export const DAG_EDGE_TYPE_SQL_LIST = DAG_EDGE_TYPES.map(() => "?").join(", ");

package segment

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lib/pq"
)

// Node is one node in a recursive filter tree.
// Leaf nodes have Field + Op + Value.
// Compound nodes (AND/OR/NOT) have Op + Conditions.
type Node struct {
	Op         string `json:"op"`
	Field      string `json:"field,omitempty"`
	Value      any    `json:"value,omitempty"`
	Conditions []Node `json:"conditions,omitempty"`
}

// Query is the top-level filter document stored in segments.query.
type Query struct {
	Op         string `json:"op"`
	Conditions []Node `json:"conditions"`
}

// ParseQuery unmarshals a JSONB query document.
func ParseQuery(raw []byte) (Query, error) {
	var q Query
	if err := json.Unmarshal(raw, &q); err != nil {
		return Query{}, fmt.Errorf("segment: parse query: %w", err)
	}
	return q, nil
}

// AllowedFields maps external field names to safe SQL identifiers.
// Only columns in this map may be referenced in a query node.
// This prevents SQL injection via field-name substitution.
var AllowedFields = map[string]string{
	"sector_primary":    "sector_primary",
	"sector_tags":       "sector_tags",
	"icp_tier":          "icp_tier",
	"icp_score":         "icp_score",
	"region_normalized": "region_normalized",
	"rating_value":      "rating_value",
	"rating_count":      "rating_count",
	"datum_vzniku":      "datum_vzniku",
	"pravni_forma":      "pravni_forma",
	"email_status":      "email_status",
	"exclusion_status":  "exclusion_status",
	"velikost_firmy":    "velikost_firmy",
	"engagement_cluster": "engagement_cluster",
}

// BuildSQL converts a Query into a parameterized WHERE clause fragment.
// startIdx is the $N index for the first positional parameter.
// Returns (clause, args, nextIdx, error).
// The returned clause does not include the "WHERE" keyword.
func BuildSQL(q Query, startIdx int) (string, []any, error) {
	clause, args, nextIdx, err := buildNode(Node{Op: q.Op, Conditions: q.Conditions}, startIdx)
	_ = nextIdx
	return clause, args, err
}

func buildNode(n Node, idx int) (string, []any, int, error) {
	op := strings.ToUpper(strings.TrimSpace(n.Op))

	switch op {
	case "AND", "OR":
		if len(n.Conditions) == 0 {
			return "TRUE", nil, idx, nil
		}
		var parts []string
		var args []any
		for _, child := range n.Conditions {
			clause, childArgs, nextIdx, err := buildNode(child, idx)
			if err != nil {
				return "", nil, idx, err
			}
			idx = nextIdx
			parts = append(parts, "("+clause+")")
			args = append(args, childArgs...)
		}
		joiner := " AND "
		if op == "OR" {
			joiner = " OR "
		}
		return strings.Join(parts, joiner), args, idx, nil

	case "NOT":
		if len(n.Conditions) != 1 {
			return "", nil, idx, fmt.Errorf("segment: NOT node must have exactly 1 condition, got %d", len(n.Conditions))
		}
		clause, args, nextIdx, err := buildNode(n.Conditions[0], idx)
		if err != nil {
			return "", nil, idx, err
		}
		return "NOT (" + clause + ")", args, nextIdx, nil

	case "IN", "EQ", "GTE", "LTE", "GT", "LT":
		col, ok := AllowedFields[n.Field]
		if !ok {
			return "", nil, idx, fmt.Errorf("segment: disallowed field %q", n.Field)
		}
		return buildLeaf(op, col, n.Value, idx)

	default:
		return "", nil, idx, fmt.Errorf("segment: unknown op %q", n.Op)
	}
}

func buildLeaf(op, col string, value any, idx int) (string, []any, int, error) {
	switch op {
	case "IN":
		// value must be []any or []string
		vals, err := toStringSlice(value)
		if err != nil {
			return "", nil, idx, fmt.Errorf("segment: IN %q: %w", col, err)
		}
		if len(vals) == 0 {
			return "FALSE", nil, idx, nil
		}
		if col == "sector_tags" {
			// Array overlap: sector_tags && ARRAY[$1, $2, ...]
			placeholders, args, nextIdx := buildArrayArgs(vals, idx)
			clause := fmt.Sprintf("%s && ARRAY[%s]", col, placeholders)
			return clause, args, nextIdx, nil
		}
		// Scalar IN: col = ANY($N::text[]).
		// F5-2 (2026-04-29): pre-fix this hand-built the array literal
		// via `"{" + strings.Join(vals, ",") + "}"`. lib/pq parses that
		// literal at the wire-protocol level: commas, quotes, and `}`
		// inside any value split or terminate the array. A user-
		// controlled segment value like `"a,b"` would arrive at the DB
		// as two elements `a` and `b` instead of the literal string
		// `a,b`. pq.Array() encodes the slice safely (lib/pq escapes
		// per-element including embedded commas/quotes/backslashes).
		clause := fmt.Sprintf("%s = ANY($%d::text[])", col, idx)
		return clause, []any{pq.Array(vals)}, idx + 1, nil

	case "EQ":
		clause := fmt.Sprintf("%s = $%d", col, idx)
		return clause, []any{value}, idx + 1, nil

	case "GTE":
		clause := fmt.Sprintf("%s >= $%d", col, idx)
		return clause, []any{value}, idx + 1, nil

	case "LTE":
		clause := fmt.Sprintf("%s <= $%d", col, idx)
		return clause, []any{value}, idx + 1, nil

	case "GT":
		clause := fmt.Sprintf("%s > $%d", col, idx)
		return clause, []any{value}, idx + 1, nil

	case "LT":
		clause := fmt.Sprintf("%s < $%d", col, idx)
		return clause, []any{value}, idx + 1, nil

	default:
		return "", nil, idx, fmt.Errorf("segment: unknown leaf op %q", op)
	}
}

func buildArrayArgs(vals []string, startIdx int) (string, []any, int) {
	placeholders := make([]string, len(vals))
	args := make([]any, len(vals))
	for i, v := range vals {
		placeholders[i] = fmt.Sprintf("$%d", startIdx+i)
		args[i] = v
	}
	return strings.Join(placeholders, ","), args, startIdx + len(vals)
}

func toStringSlice(v any) ([]string, error) {
	switch val := v.(type) {
	case []string:
		return val, nil
	case []any:
		result := make([]string, 0, len(val))
		for _, item := range val {
			s, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("expected string element, got %T", item)
			}
			result = append(result, s)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("expected []string or []any, got %T", v)
	}
}

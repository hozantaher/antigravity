package classify

import "log/slog"

// recordUnmappedCategoryPath logs category paths that could not be resolved to
// a known sector tag. This feeds future taxonomy improvement work.
func recordUnmappedCategoryPath(path string) {
	slog.Debug("unmapped category path", "path", path)
}

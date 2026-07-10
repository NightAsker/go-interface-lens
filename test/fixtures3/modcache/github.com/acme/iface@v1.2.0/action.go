package iface

import "context"

// IActionExecutorWithCode is declared in a dependency (module cache).
type IActionExecutorWithCode interface {
	Execute(ctx context.Context, code string) (string, error)
	Code() string
}

// Unrelated interface that shares the Code() method name but a different shape,
// used to verify signature-aware matching does not over-match.
type Coder interface {
	Code() int
}

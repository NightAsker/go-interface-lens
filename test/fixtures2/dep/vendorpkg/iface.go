package vendorpkg

import "context"

// IActionExecutorWithCode declared in a dependency package (outside the project).
type IActionExecutorWithCode interface {
	Execute(ctx context.Context, code string) (string, error)
	Code() string
}

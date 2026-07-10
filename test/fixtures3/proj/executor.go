package impl

import "context"

// ProjectExecutor is implemented in the user's project and satisfies the
// dependency interface IActionExecutorWithCode.
type ProjectExecutor struct{}

func (e *ProjectExecutor) Execute(ctx context.Context, code string) (string, error) {
	return "", nil
}

func (e *ProjectExecutor) Code() string { return "" }

package impl

import "context"

// ProjectExecutor lives in the user's own project and implements the
// dependency interface IActionExecutorWithCode.
type ProjectExecutor struct{}

func (e *ProjectExecutor) Execute(ctx context.Context, code string) (string, error) {
	return "", nil
}

func (e *ProjectExecutor) Code() string { return "" }

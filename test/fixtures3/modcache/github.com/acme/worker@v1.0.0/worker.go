package worker

type ExplicitDependencyWorker struct{}

func (*ExplicitDependencyWorker) ResolveExplicitDependency(string) error { return nil }

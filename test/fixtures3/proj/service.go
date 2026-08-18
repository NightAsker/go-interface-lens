package impl

type ExplicitDependencyService interface {
	ResolveExplicitDependency(string) error
}

package pkg

import "context"

type Store interface {
	Get(ctx context.Context, id string) (string, error)
	Put(ctx context.Context, id string, val string) error
}

// PostgresStore fully implements Store.
type PostgresStore struct{}

func (s *PostgresStore) Get(ctx context.Context, id string) (string, error) {
	return "", nil
}

func (s *PostgresStore) Put(ctx context.Context, id string, val string) error {
	return nil
}

// PartialStore only implements Get, so it must NOT match Store.
type PartialStore struct{}

func (p *PartialStore) Get(ctx context.Context, id string) (string, error) {
	return "", nil
}

// WrongSigStore has Get/Put by name but wrong signatures.
type WrongSigStore struct{}

func (w WrongSigStore) Get(id string) string { return "" }
func (w WrongSigStore) Put(id string)        {}

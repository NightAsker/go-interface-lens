package sub

import "context"

// MemStore in another file/package-dir also implements the Store shape.
type MemStore struct{}

func (m *MemStore) Get(ctx context.Context, id string) (string, error) {
	return "", nil
}

func (m *MemStore) Put(ctx context.Context, id string, val string) error {
	return nil
}

// MockStore should be filtered out by exclusion rules (type pattern "Mock").
type MockStore struct{}

func (m *MockStore) Get(ctx context.Context, id string) (string, error) { return "", nil }
func (m *MockStore) Put(ctx context.Context, id string, val string) error { return nil }

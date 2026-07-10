package pkg

import "io"

// Custom embeds a well-known stdlib interface (io.Reader) whose method set is
// known, so it is expanded to {Read, Extra}. A type that only implements Extra
// must NOT be reported as implementing Custom; a type implementing both Read
// and Extra must be.
type Custom interface {
	io.Reader
	Extra() string
}

// PartialCustom implements only Extra, not Read — must NOT match Custom.
type PartialCustom struct{}

func (p *PartialCustom) Extra() string { return "" }

// FullCustom implements both Read and Extra — must match Custom.
type FullCustom struct{}

func (f *FullCustom) Read(p []byte) (int, error) { return 0, nil }

func (f *FullCustom) Extra() string { return "" }

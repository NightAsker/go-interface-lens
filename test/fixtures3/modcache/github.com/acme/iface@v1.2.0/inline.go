package iface

type InlineExecutor interface { Inline() error }

type ExtendedInlineExecutor interface { InlineExecutor }

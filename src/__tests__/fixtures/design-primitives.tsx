// Test-only host-module double: no product classes or variant recipes.
// Fixtures are excluded from the published package and the host program.
import * as React from "react";

export function Button(props: React.ComponentProps<"button">) {
  return <button data-slot="button" {...props} />;
}

export function Input(props: React.ComponentProps<"input">) {
  return <input data-slot="input" {...props} />;
}

export function Card(props: React.ComponentProps<"div">) {
  return <div data-slot="card" {...props} />;
}

export function CardHeader(props: React.ComponentProps<"div">) {
  return <div data-slot="card-header" {...props} />;
}

export function CardTitle(props: React.ComponentProps<"div">) {
  return <div data-slot="card-title" {...props} />;
}

export function CardDescription(props: React.ComponentProps<"div">) {
  return <div data-slot="card-description" {...props} />;
}

export function CardContent(props: React.ComponentProps<"div">) {
  return <div data-slot="card-content" {...props} />;
}

import { Card, PageHeader } from '@/components/ui';

/** Honest placeholder for modules that are designed (see docs/DATABASE.md) but not built yet. */
export function Planned({ title, intro, features }: { title: string; intro: string; features: string[] }) {
  return (
    <>
      <PageHeader title={title} sub="Designed, coming in the next phase" />
      <Card title="What this module will do" sub={intro}>
        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="rounded-[var(--radius-inner)] bg-panel-2 px-4 py-3 font-medium">{f}</li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted">The data model is in docs/DATABASE.md and the screens in docs/USER_FLOWS.md.</p>
      </Card>
    </>
  );
}

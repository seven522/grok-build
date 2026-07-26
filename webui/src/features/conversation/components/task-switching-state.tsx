import { LoaderFive } from '@/components/ui/loader'

type TaskSwitchingStateProps = {
  title: string
}

export const TaskSwitchingState = ({ title }: TaskSwitchingStateProps) => (
  <section className="task-content-pending" role="status" aria-live="polite">
    <LoaderFive
      className="task-switching-loader"
      text={`正在打开“${title}”`}
    />
  </section>
)

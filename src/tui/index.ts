/**
 * TUI Module — Terminal User Interface components for smolerclaw.
 *
 * Re-exports all TUI components for convenient importing.
 */

// Components
export {
  renderSparkline,
  renderLabeledSparkline,
  renderBar,
  renderBarChart,
  renderProgressBar,
  renderStatusBar,
  drawStatusBar,
  drawStickyStatusBar,
  renderTelemetryPanel,
  renderBox,
  drawPanel,
  renderDivider,
  type StatusBarConfig,
  type StatusBarItem,
  type SparklineOptions,
  type BarChartOptions,
  type ProgressBarOptions,
  type BoxOptions,
  type StickyStatusState,
  type TelemetryData,
} from './components'

// Tables
export {
  renderTable,
  quickTable,
  kvTable,
  bulletList,
  renderADRTable,
  renderFinancialTable,
  renderProjectTable,
  type TableColumn,
  type TableCell,
  type TableRow,
  type TableOptions,
  type CellAlign,
  type ADREntry,
  type FinancialEntry,
  type ProjectEntry,
} from './tables'

// Views
export {
  ViewManager,
  viewManager,
  renderSplitView,
  renderTripleView,
  fadeOutScreen,
  wipeTransition,
  calculatePanelLayout,
  centerContent,
  setScrollRegion,
  resetScrollRegion,
  saveCursor,
  restoreCursor,
  type ViewMode,
  type ViewState,
  type DashboardPanel,
  type DashboardLayout,
} from './views'

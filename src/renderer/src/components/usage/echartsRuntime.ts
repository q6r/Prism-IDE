// Loaded on demand by EChartsView, so ECharts never weighs on the main bundle.
// Tree-shaken registration: only what the usage chart draws with. SVG, so the
// image export clones real vector nodes.
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, SVGRenderer])

export { echarts }

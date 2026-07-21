import HeatmapView from './HeatmapView'
import './App.css'

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Single-cell Heatmap</h1>
        <span className="subtitle">cellxgene · zarr pyramid · deck.gl</span>
      </header>
      <HeatmapView />
    </div>
  )
}

export default App

import { render } from 'preact'
import { createClient } from '../app/client'
import { App } from './App'
import './styles.css'

render(<App client={createClient()} />, document.getElementById('app')!)

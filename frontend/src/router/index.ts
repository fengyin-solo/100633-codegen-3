import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Tunnel = () => import('@/views/tunnel/index.vue')
const Pipeline = () => import('@/views/pipeline/index.vue')
const Envmonitor = () => import('@/views/envmonitor/index.vue')
const Ventilation = () => import('@/views/ventilation/index.vue')
const Drainage = () => import('@/views/drainage/index.vue')
const Firecontrol = () => import('@/views/firecontrol/index.vue')
const Lighting = () => import('@/views/lighting/index.vue')
const Access = () => import('@/views/access/index.vue')
const Patrol = () => import('@/views/patrol/index.vue')
const Cleaning = () => import('@/views/cleaning/index.vue')
const Settlement = () => import('@/views/settlement/index.vue')
const Leak = () => import('@/views/leak/index.vue')
const Maintenance = () => import('@/views/maintenance/index.vue')
const Hazard = () => import('@/views/hazard/index.vue')
const Emergency = () => import('@/views/emergency/index.vue')
const Energy = () => import('@/views/energy/index.vue')
const Device = () => import('@/views/device/index.vue')
const Entryapprove = () => import('@/views/entryapprove/index.vue')
const Duty = () => import('@/views/duty/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/tunnel', name: 'tunnel', component: Tunnel },
    { path: '/pipeline', name: 'pipeline', component: Pipeline },
    { path: '/envmonitor', name: 'envmonitor', component: Envmonitor },
    { path: '/ventilation', name: 'ventilation', component: Ventilation },
    { path: '/drainage', name: 'drainage', component: Drainage },
    { path: '/firecontrol', name: 'firecontrol', component: Firecontrol },
    { path: '/lighting', name: 'lighting', component: Lighting },
    { path: '/access', name: 'access', component: Access },
    { path: '/patrol', name: 'patrol', component: Patrol },
    { path: '/cleaning', name: 'cleaning', component: Cleaning },
    { path: '/settlement', name: 'settlement', component: Settlement },
    { path: '/leak', name: 'leak', component: Leak },
    { path: '/maintenance', name: 'maintenance', component: Maintenance },
    { path: '/hazard', name: 'hazard', component: Hazard },
    { path: '/emergency', name: 'emergency', component: Emergency },
    { path: '/energy', name: 'energy', component: Energy },
    { path: '/device', name: 'device', component: Device },
    { path: '/entryapprove', name: 'entryapprove', component: Entryapprove },
    { path: '/duty', name: 'duty', component: Duty },
  ],
})

export default router

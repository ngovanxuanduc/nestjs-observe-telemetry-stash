export function buildGaugeMetric(name: string, value: number, timeNs: string) {
  return {
    name,
    gauge: { dataPoints: [{ timeUnixNano: timeNs, asDouble: Number(value) }] },
  };
}

export function buildSumMetric(name: string, value: number, timeNs: string) {
  return {
    name,
    sum: {
      dataPoints: [{ timeUnixNano: timeNs, asDouble: Number(value) }],
      isMonotonic: true,
      aggregationTemporality: 2,
    },
  };
}

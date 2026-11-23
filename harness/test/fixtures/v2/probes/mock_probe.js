export const probeName = "mock_probe";
export const aliases = ["mock.probe_elements"];

export async function runProbe(pageHandle) {
  const count = await pageHandle.page.evaluate(() => document.querySelectorAll("[data-mock-item]").length);
  return {
    "mock.probe_elements": count,
    details: { count }
  };
}

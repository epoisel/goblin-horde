const form = document.querySelector("#pair-form");
const input = document.querySelector("#code");
const errorBox = document.querySelector("#pair-error");
document.querySelector("#code-help").addEventListener("click", () => {
  window.open("https://mail.google.com/mail/u/0/#search/subject%3A%22Your%20Goblin%20Horde%20code%22%20OR%20subject%3A%22Your%20Activity%20Lens%20code%22", "_blank", "noopener,noreferrer");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  errorBox.hidden = true;
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: input.value.trim().toUpperCase() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to pair this phone.");
    location.replace("/");
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    button.disabled = false;
  }
});

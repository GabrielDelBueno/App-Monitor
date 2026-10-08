(() => {
  const normalized = (value) =>
    value
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  window.parseSchoolInventory = (source) => {
    if (source.length > 5_000_000)
      throw Error("Planilha muito grande. Limite: 5 MB.");
    // This export is an HTML table with .xls extension, not a binary Excel file.
    if (!/^\s*(?:\ufeff)?\s*</.test(source))
      throw Error(
        "Use a planilha .xls exportada pelo inventário da escola (tabela HTML).",
      );
    const doc = new DOMParser().parseFromString(source, "text/html");
    const rows = [...doc.querySelectorAll("tr")];
    const headerIndex = rows.findIndex((row) =>
      [...row.querySelectorAll("th,td")].some(
        (cell) =>
          normalized(cell.textContent) === "ID DE CONTROLE INTERNO DA UE",
      ),
    );
    if (headerIndex < 0) throw Error("Cabeçalho do inventário não encontrado.");
    const headers = [...rows[headerIndex].querySelectorAll("th,td")].map(
      (cell) => normalized(cell.textContent),
    );
    const required = [
      "CATEGORIA DO EQUIPAMENTO",
      "FABRICANTE",
      "MODELO",
      "NUMERO DE SERIE",
      "ID DE CONTROLE INTERNO DA UE",
      "STATUS DO EQUIPAMENTO",
      "AVALIACAO TECNICA",
    ];
    if (required.some((header) => !headers.includes(header)))
      throw Error("Faltam colunas obrigatórias no inventário.");
    const types = {
      TABLET: "TABLET",
      "NOTEBOOK SALA DE AULA": "NOTEBOOK",
      "NOTEBOOK BASICO EDUCACIONAL": "NOTEBOOK",
      SMARTPHONE: "CELULAR",
    };
    const records = [],
      counts = {},
      missingSerial = [];
    let excluded = 0;
    rows.slice(headerIndex + 1).forEach((row, index) => {
      const cells = [...row.querySelectorAll("td")].map((cell) =>
        cell.textContent.trim(),
      );
      if (!cells.length) return;
      const value = (header) => cells[headers.indexOf(header)] || "";
      const category = value("CATEGORIA DO EQUIPAMENTO");
      const type = types[normalized(category)];
      if (
        !type ||
        normalized(value("STATUS DO EQUIPAMENTO")) !== "DISPONIVEL"
      ) {
        excluded++;
        return;
      }
      const number = value("ID DE CONTROLE INTERNO DA UE");
      if (!number)
        throw Error(
          `Linha ${headerIndex + index + 2}: falta o controle interno da UE.`,
        );
      const serial_number = value("NUMERO DE SERIE");
      const evaluation = value("AVALIACAO TECNICA");
      records.push({
        number,
        internal_id: number,
        serial_number,
        manufacturer: value("FABRICANTE"),
        model: value("MODELO"),
        qr: `APP-MONITOR:${number}`,
        type,
        status: normalized(evaluation) === "BOM" ? "BOM_ESTADO" : "CONSERVADO",
        notes: `Origem: inventário da escola. Categoria: ${category}. Status na planilha: Disponível. Avaliação técnica: ${evaluation || "Não informada"}.`,
      });
      counts[category] = (counts[category] || 0) + 1;
      if (!serial_number) missingSerial.push(number);
    });
    if (!records.length)
      throw Error("Nenhum aparelho disponível nas categorias selecionadas.");
    return { records, counts, missingSerial, excluded };
  };
})();

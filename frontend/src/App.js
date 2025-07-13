import React, { useState, useEffect } from "react";
import "./App.css";
import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const BeamDesigner = () => {
  const [inputs, setInputs] = useState({
    width: 30,
    height: 60,
    length: 6,
    dead_load: 15,
    live_load: 10,
    fc: 21,
    fy: 420,
    cover: 4
  });
  
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savedDesigns, setSavedDesigns] = useState([]);
  const [projectName, setProjectName] = useState("");
  const [beamName, setBeamName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);

  const handleInputChange = (field, value) => {
    setInputs(prev => ({
      ...prev,
      [field]: parseFloat(value) || 0
    }));
  };

  const calculateDesign = async () => {
    setLoading(true);
    try {
      const response = await axios.post(`${API}/beam/design`, inputs);
      setResults(response.data);
    } catch (error) {
      console.error('Error calculating design:', error);
      alert('Error en el cálculo. Verificar datos ingresados.');
    }
    setLoading(false);
  };

  const saveDesign = async () => {
    if (!projectName || !beamName) {
      alert('Ingrese nombre del proyecto y viga');
      return;
    }
    
    try {
      await axios.post(`${API}/beam/save`, {
        project_name: projectName,
        beam_name: beamName,
        inputs: inputs
      });
      alert('Diseño guardado correctamente');
      setShowSaveForm(false);
      loadSavedDesigns();
    } catch (error) {
      console.error('Error saving design:', error);
      alert('Error al guardar el diseño');
    }
  };

  const loadSavedDesigns = async () => {
    try {
      const response = await axios.get(`${API}/beam/designs`);
      setSavedDesigns(response.data);
    } catch (error) {
      console.error('Error loading designs:', error);
    }
  };

  const loadDesign = (design) => {
    setInputs(design.inputs);
    setResults(design.results);
  };

  useEffect(() => {
    loadSavedDesigns();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">
            Diseño de Vigas de Concreto Armado
          </h1>
          <p className="text-lg text-gray-600">
            Norma E.060 - Reglamento Nacional de Edificaciones (Perú)
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Input Panel */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-xl font-semibold mb-4 text-gray-800">
                Datos de Entrada
              </h2>
              
              {/* Geometry Section */}
              <div className="mb-6">
                <h3 className="text-lg font-medium mb-3 text-gray-700">Geometría</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Ancho (cm)
                    </label>
                    <input
                      type="number"
                      value={inputs.width}
                      onChange={(e) => handleInputChange('width', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Altura (cm)
                    </label>
                    <input
                      type="number"
                      value={inputs.height}
                      onChange={(e) => handleInputChange('height', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Longitud (m)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={inputs.length}
                      onChange={(e) => handleInputChange('length', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Recubrimiento (cm)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      value={inputs.cover}
                      onChange={(e) => handleInputChange('cover', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Loads Section */}
              <div className="mb-6">
                <h3 className="text-lg font-medium mb-3 text-gray-700">Cargas</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Carga Muerta (kN/m)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={inputs.dead_load}
                      onChange={(e) => handleInputChange('dead_load', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Carga Viva (kN/m)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={inputs.live_load}
                      onChange={(e) => handleInputChange('live_load', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Materials Section */}
              <div className="mb-6">
                <h3 className="text-lg font-medium mb-3 text-gray-700">Materiales</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      f'c (MPa)
                    </label>
                    <input
                      type="number"
                      value={inputs.fc}
                      onChange={(e) => handleInputChange('fc', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      fy (MPa)
                    </label>
                    <input
                      type="number"
                      value={inputs.fy}
                      onChange={(e) => handleInputChange('fy', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={calculateDesign}
                disabled={loading}
                className="w-full bg-blue-600 text-white py-3 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 font-medium"
              >
                {loading ? 'Calculando...' : 'Calcular Diseño'}
              </button>
            </div>
          </div>

          {/* Results Panel */}
          <div className="lg:col-span-2">
            {results && (
              <div className="bg-white rounded-lg shadow-lg p-6">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-semibold text-gray-800">
                    Resultados del Diseño
                  </h2>
                  <button
                    onClick={() => setShowSaveForm(true)}
                    className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700"
                  >
                    Guardar Diseño
                  </button>
                </div>

                {/* Validation Status */}
                <div className={`p-4 rounded-md mb-6 ${
                  results.is_valid 
                    ? 'bg-green-100 border border-green-400 text-green-700'
                    : 'bg-red-100 border border-red-400 text-red-700'
                }`}>
                  <h3 className="font-medium">
                    {results.is_valid ? '✓ Diseño Válido' : '✗ Diseño No Válido'}
                  </h3>
                  {results.messages.length > 0 && (
                    <ul className="mt-2 list-disc list-inside">
                      {results.messages.map((msg, idx) => (
                        <li key={idx}>{msg}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Analysis Results */}
                  <div>
                    <h3 className="text-lg font-medium mb-3 text-gray-700">Análisis</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span>Carga Total:</span>
                        <span className="font-medium">{results.total_load.toFixed(2)} kN/m</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Momento Servicio:</span>
                        <span className="font-medium">{results.max_moment_service.toFixed(2)} kN⋅m</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Momento Último:</span>
                        <span className="font-medium">{results.max_moment_ultimate.toFixed(2)} kN⋅m</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Peralte Efectivo:</span>
                        <span className="font-medium">{results.effective_depth.toFixed(1)} cm</span>
                      </div>
                    </div>
                  </div>

                  {/* Material Properties */}
                  <div>
                    <h3 className="text-lg font-medium mb-3 text-gray-700">Propiedades</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span>β₁:</span>
                        <span className="font-medium">{results.beta1.toFixed(3)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ρ balanceada:</span>
                        <span className="font-medium">{(results.rho_balanced * 1000).toFixed(2)} ‰</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ρ mínima:</span>
                        <span className="font-medium">{(results.rho_min * 1000).toFixed(2)} ‰</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ρ máxima:</span>
                        <span className="font-medium">{(results.rho_max * 1000).toFixed(2)} ‰</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Steel Requirements */}
                <div className="mt-6">
                  <h3 className="text-lg font-medium mb-3 text-gray-700">Acero de Refuerzo</h3>
                  <div className="bg-gray-50 p-4 rounded-md">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div className="text-sm text-gray-600">Área Requerida:</div>
                        <div className="text-lg font-medium">{results.required_as.toFixed(2)} cm²</div>
                      </div>
                      <div>
                        <div className="text-sm text-gray-600">Cuantía Requerida:</div>
                        <div className="text-lg font-medium">{(results.required_rho * 1000).toFixed(2)} ‰</div>
                      </div>
                    </div>
                    
                    <div className="mt-4 p-3 bg-blue-50 rounded-md border border-blue-200">
                      <div className="text-sm font-medium text-blue-800 mb-1">Refuerzo Sugerido:</div>
                      <div className="text-lg font-bold text-blue-900">{results.suggested_bars}</div>
                      <div className="text-sm text-blue-700 mt-2">
                        Cuantía colocada: {(results.actual_rho * 1000).toFixed(2)} ‰
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Saved Designs */}
            {savedDesigns.length > 0 && (
              <div className="bg-white rounded-lg shadow-lg p-6 mt-6">
                <h2 className="text-xl font-semibold mb-4 text-gray-800">
                  Diseños Guardados
                </h2>
                <div className="space-y-2">
                  {savedDesigns.slice(0, 5).map(design => (
                    <div
                      key={design.id}
                      className="flex justify-between items-center p-3 bg-gray-50 rounded-md hover:bg-gray-100 cursor-pointer"
                      onClick={() => loadDesign(design)}
                    >
                      <div>
                        <div className="font-medium">{design.beam_name}</div>
                        <div className="text-sm text-gray-600">{design.project_name}</div>
                      </div>
                      <div className="text-sm text-gray-500">
                        {new Date(design.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Save Form Modal */}
        {showSaveForm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg max-w-md w-full mx-4">
              <h3 className="text-lg font-semibold mb-4">Guardar Diseño</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    Nombre del Proyecto
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    Nombre de la Viga
                  </label>
                  <input
                    type="text"
                    value={beamName}
                    onChange={(e) => setBeamName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-4 mt-6">
                <button
                  onClick={saveDesign}
                  className="flex-1 bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700"
                >
                  Guardar
                </button>
                <button
                  onClick={() => setShowSaveForm(false)}
                  className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function App() {
  return (
    <div className="App">
      <BeamDesigner />
    </div>
  );
}

export default App;
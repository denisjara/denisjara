from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import math
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models for Beam Design
class BeamInputs(BaseModel):
    # Geometry
    width: float = Field(..., description="Ancho de viga (cm)")
    height: float = Field(..., description="Altura de viga (cm)")
    length: float = Field(..., description="Longitud de viga (m)")
    
    # Loads
    dead_load: float = Field(..., description="Carga muerta (kN/m)")
    live_load: float = Field(..., description="Carga viva (kN/m)")
    
    # Materials
    fc: float = Field(..., description="Resistencia del concreto f'c (MPa)")
    fy: float = Field(..., description="Resistencia del acero fy (MPa)")
    
    # Cover
    cover: float = Field(default=4.0, description="Recubrimiento (cm)")

class BeamResults(BaseModel):
    # Input summary
    inputs: BeamInputs
    
    # Load calculations
    total_load: float
    max_moment_service: float
    max_moment_ultimate: float
    
    # Material properties
    beta1: float
    rho_balanced: float
    rho_min: float
    rho_max: float
    
    # Design results
    effective_depth: float
    required_moment_capacity: float
    required_rho: float
    required_as: float
    
    # Verification
    is_valid: bool
    messages: List[str]
    
    # Reinforcement suggestion
    suggested_bars: str
    actual_as: float
    actual_rho: float

class BeamDesign(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    project_name: str
    beam_name: str
    inputs: BeamInputs
    results: BeamResults
    created_at: datetime = Field(default_factory=datetime.utcnow)

class BeamDesignCreate(BaseModel):
    project_name: str
    beam_name: str
    inputs: BeamInputs


def calculate_beam_design(inputs: BeamInputs) -> BeamResults:
    """
    Calcular diseño de viga según Norma E.060 del RNE (Perú)
    """
    try:
        # Convert units
        b = inputs.width / 100  # cm to m
        h = inputs.height / 100  # cm to m
        L = inputs.length  # m
        wD = inputs.dead_load  # kN/m
        wL = inputs.live_load  # kN/m
        fc = inputs.fc  # MPa
        fy = inputs.fy  # MPa
        cover = inputs.cover / 100  # cm to m
        
        messages = []
        
        # 1. Load calculations
        w_total = wD + wL
        M_service = w_total * L**2 / 8  # kN⋅m for simply supported beam
        
        # Ultimate moment (E.060 load combinations)
        M_ultimate = 1.4 * (wD * L**2 / 8) + 1.7 * (wL * L**2 / 8)  # kN⋅m
        
        # 2. Material properties and factors (E.060)
        # Factor de reducción para flexión
        phi = 0.90
        
        # Beta1 factor (E.060)
        if fc <= 28:
            beta1 = 0.85
        else:
            beta1 = max(0.65, 0.85 - 0.05 * (fc - 28) / 7)
        
        # Effective depth
        d = h - cover - 0.01  # assuming 1cm for bar radius
        
        # 3. Calculate balanced reinforcement ratio (E.060)
        # ρb = (0.85 * fc * β1 / fy) * (600 / (600 + fy))
        rho_balanced = (0.85 * fc * beta1 / fy) * (600 / (600 + fy))
        
        # Minimum reinforcement ratio (E.060)
        # As_min = max(0.26 * bt * d / fy, 0.0013 * bt * d)
        # Converting to reinforcement ratio: rho_min = As_min / (bt * d)
        rho_min = max(0.26 / fy, 0.0013)
        
        # Maximum reinforcement ratio (E.060)
        rho_max = 0.75 * rho_balanced
        
        # 4. Required moment capacity
        Mu_required = M_ultimate  # kN⋅m
        
        # 5. Calculate required reinforcement
        # Convert Mu to N⋅mm for consistency with MPa units
        Mu_N_mm = M_ultimate * 1000 * 1000  # kN⋅m to N⋅mm
        
        # Calculate Ru in MPa
        Ru = Mu_N_mm / (phi * b * 1000 * d * 1000 * d * 1000)  # N⋅mm / (mm * mm * mm) = MPa
        
        # Calculate required rho using quadratic formula approach
        # For rectangular beam: Ru = rho * fy * (1 - 0.59 * rho * fy / fc)
        # Rearranging: 0.59 * (fy/fc) * rho^2 - rho + Ru/fy = 0
        
        a_coeff = 0.59 * fy / fc
        b_coeff = -1.0
        c_coeff = Ru / fy
        
        discriminant = b_coeff**2 - 4 * a_coeff * c_coeff
        
        if discriminant < 0:
            # If discriminant is negative, use approximation
            rho_required = Ru / (0.9 * fy)
        else:
            # Use smaller root (compression controlled)
            rho_required = (-b_coeff - math.sqrt(discriminant)) / (2 * a_coeff)
        
        # Check limits
        if rho_required < rho_min:
            rho_required = rho_min
            messages.append("Se usa cuantía mínima")
        elif rho_required > rho_max:
            messages.append("ERROR: Cuantía excede el máximo permitido. Aumentar sección.")
            
        # Required steel area
        As_required = rho_required * b * d  # m²
        As_required_cm2 = As_required * 10000  # cm²
        
        # 6. Verification
        is_valid = rho_required <= rho_max and As_required > 0
        
        if not is_valid:
            messages.append("Diseño no válido - revisar dimensiones o cargas")
        
        # 7. Steel bar suggestion (common bars in Peru)
        # Common diameters: 8mm, 10mm, 12mm, 16mm, 20mm, 25mm
        bar_areas = {
            8: 0.503,   # cm²
            10: 0.785,  # cm²
            12: 1.131,  # cm²
            16: 2.011,  # cm²
            20: 3.142,  # cm²
            25: 4.909   # cm²
        }
        
        best_combination = ""
        actual_as = 0
        
        # Try single bar size first
        for diameter in [25, 20, 16, 12, 10, 8]:
            area_per_bar = bar_areas[diameter]
            num_bars = math.ceil(As_required_cm2 / area_per_bar)
            
            if num_bars <= 8 and num_bars >= 2:  # practical limits
                actual_as = num_bars * area_per_bar
                best_combination = f"{num_bars}φ{diameter}mm (As = {actual_as:.2f} cm²)"
                break
        
        # If no single bar solution, try combinations
        if not best_combination:
            # Try combination with larger bars first
            for main_diameter in [25, 20, 16]:
                main_area = bar_areas[main_diameter]
                max_main_bars = min(6, int(As_required_cm2 / main_area))
                
                for num_main in range(max_main_bars, 0, -1):
                    remaining_area = As_required_cm2 - num_main * main_area
                    
                    if remaining_area <= 0:
                        actual_as = num_main * main_area
                        best_combination = f"{num_main}φ{main_diameter}mm (As = {actual_as:.2f} cm²)"
                        break
                    
                    # Find secondary bars
                    for sec_diameter in [20, 16, 12]:
                        if sec_diameter >= main_diameter:
                            continue
                        sec_area = bar_areas[sec_diameter]
                        num_sec = math.ceil(remaining_area / sec_area)
                        
                        if num_sec <= 4 and (num_main + num_sec) <= 8:
                            actual_as = num_main * main_area + num_sec * sec_area
                            best_combination = f"{num_main}φ{main_diameter}mm + {num_sec}φ{sec_diameter}mm (As = {actual_as:.2f} cm²)"
                            break
                    
                    if best_combination:
                        break
                
                if best_combination:
                    break
        
        # Fallback if no good combination found
        if not best_combination:
            num_bars = math.ceil(As_required_cm2 / bar_areas[20])
            actual_as = num_bars * bar_areas[20]
            best_combination = f"{num_bars}φ20mm (As = {actual_as:.2f} cm²)"
        
        actual_rho = (actual_as / 10000) / (b * d)
        
        # Final verification message
        if actual_rho > rho_max:
            messages.append("ADVERTENCIA: Acero colocado excede cuantía máxima")
            is_valid = False
        
        return BeamResults(
            inputs=inputs,
            total_load=w_total,
            max_moment_service=M_service,
            max_moment_ultimate=M_ultimate,
            beta1=beta1,
            rho_balanced=rho_balanced,
            rho_min=rho_min,
            rho_max=rho_max,
            effective_depth=d * 100,  # convert back to cm
            required_moment_capacity=Mu_required,
            required_rho=rho_required,
            required_as=As_required_cm2,
            is_valid=is_valid,
            messages=messages,
            suggested_bars=best_combination,
            actual_as=actual_as,
            actual_rho=actual_rho
        )
        
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error en cálculos: {str(e)}")


# API Routes
@api_router.post("/beam/design", response_model=BeamResults)
async def design_beam(inputs: BeamInputs):
    """Calcular diseño de viga según norma E.060"""
    return calculate_beam_design(inputs)

@api_router.post("/beam/save", response_model=BeamDesign)
async def save_beam_design(design_data: BeamDesignCreate):
    """Guardar diseño de viga en base de datos"""
    results = calculate_beam_design(design_data.inputs)
    
    beam_design = BeamDesign(
        project_name=design_data.project_name,
        beam_name=design_data.beam_name,
        inputs=design_data.inputs,
        results=results
    )
    
    await db.beam_designs.insert_one(beam_design.dict())
    return beam_design

@api_router.get("/beam/designs", response_model=List[BeamDesign])
async def get_beam_designs():
    """Obtener todos los diseños guardados"""
    designs = await db.beam_designs.find().sort("created_at", -1).to_list(100)
    return [BeamDesign(**design) for design in designs]

@api_router.get("/beam/design/{design_id}", response_model=BeamDesign)
async def get_beam_design(design_id: str):
    """Obtener un diseño específico"""
    design = await db.beam_designs.find_one({"id": design_id})
    if not design:
        raise HTTPException(status_code=404, detail="Diseño no encontrado")
    return BeamDesign(**design)

@api_router.get("/")
async def root():
    return {"message": "API de Diseño de Vigas - Norma E.060 Peruana"}

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()